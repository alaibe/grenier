// Run by hand with `pnpm test:agents`: the proxy must cut a read-only run off at the stand-in model's edit.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "@grenier/core/node";
import { repoId } from "@grenier/git";
import { ensureRepoTop } from "@grenier/index";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRoutine, routineFromForm } from "../../apps/cli/src/routines.ts";
import { freePort, messageStream } from "../support/anthropic.ts";
import { startDaemon } from "../support/daemon.ts";
import { storeDeps } from "../support/repo.ts";

const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));
const claude = (() => {
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();

let dir: string;
let repo: string;
let upstream: Server;
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
let port: number;
const offered: string[][] = [];

const env = () => ({
  PATH: process.env.PATH,
  HOME: join(dir, "home"),
  GRENIER_HOME: join(dir, ".grenier"),
  CLAUDE_CONFIG_DIR: join(dir, ".claude"),
  ANTHROPIC_API_KEY: "sk-ant-stand-in-key",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
});

interface Run {
  routineId: string;
  status: string;
  result: string | null;
}

/** The daemon's admin API, as the app's Routines screen calls it. */
async function admin<T>(path: string, body?: unknown): Promise<T> {
  const token = readFileSync(resolvePaths(env()).adminToken, "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${port}/admin${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, path).toBeLessThan(300);
  return (await response.json()) as T;
}

describe.skipIf(claude === null)("a routine's run with Claude Code", () => {
  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-claude-routine-")));
    repo = join(dir, "app");
    mkdirSync(repo);
    mkdirSync(join(dir, "home"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@x.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@x.invalid",
        },
      });
    git("init", "-q");
    writeFileSync(join(repo, "app.ts"), "export const app = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");

    // The stand-in model edits app.ts whenever it has tools to call, whatever tools it was offered.
    upstream = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const path = request.url ?? "";
        if (path.startsWith("/v1/messages/count_tokens")) {
          response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":25}');
          return;
        }
        if (!path.startsWith("/v1/messages")) {
          response.writeHead(404, { "content-type": "application/json" }).end("{}");
          return;
        }
        const parsed = JSON.parse(body || "{}") as { model?: string; tools?: { name: string }[] };
        const tools = (parsed.tools ?? []).map((tool) => tool.name);
        if (tools.length > 0) offered.push(tools);
        const block =
          tools.length > 0
            ? {
                type: "tool_use" as const,
                id: "toolu_edit",
                name: "Edit",
                input: { file_path: join(repo, "app.ts"), old_string: "1", new_string: "2" },
              }
            : { type: "text" as const, text: "ok" };
        response
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(messageStream(parsed.model ?? "claude-opus-5-5", block));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    port = await freePort();
    const paths = resolvePaths(env());
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(
      paths.config,
      [
        `[proxy]\nport = ${port}\nupstream_anthropic = "http://127.0.0.1:${(upstream.address() as AddressInfo).port}"`,
        `[store]\nembeddings = "off"`,
        `[machine]\nroutines = true\nidle_minutes = 0\nplugged_in = false\ncpu_max = 1\nmemory_max = 1`,
      ].join("\n\n"),
    );
    daemon = await startDaemon(BINARY, env(), dir);
  });

  afterAll(async () => {
    await daemon?.stop();
    await new Promise((resolve) => upstream?.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("offers the agent read tools only, and cuts the run off at an edit", async () => {
    // Written as the app's New routine form writes it, in Me since this machine has no team.
    const store = openSqliteStore(resolvePaths(env()).db);
    const repoIdentity = (await repoId(repo)) as string;
    await ensureRepoTop(store, { root: repo, id: repoIdentity });
    const form = routineFromForm({ title: "Tidy", prompt: "Tidy app.ts.", tools: "Edit", repo: repoIdentity });
    const { id } = await addRoutine(await storeDeps(store), { ...form, top: "me" });
    await store.close();
    await admin(`/routines/${id}/approve`, { mode: "read-only" });

    const started = Date.now();
    await admin(`/routines/${id}/run`, {});
    let run: Run | undefined;
    while (run === undefined || run.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      run = (await admin<{ runs: Run[] }>("/runs")).runs.find((entry) => entry.routineId === id);
    }
    expect(run.status).toBe("cut");
    expect(run.result).toContain("Cut off: it called Edit");
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(offered.length).toBeGreaterThan(0);
    for (const tools of offered) {
      expect(tools).not.toContain("Edit");
      expect(tools).not.toContain("Bash");
    }
    expect(readFileSync(join(repo, "app.ts"), "utf8")).toBe("export const app = 1;\n");
  }, 120_000);
});
