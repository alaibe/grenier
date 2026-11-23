// Run by hand with `pnpm test:agents`: the proxy must cut a read-only run off at the stand-in model's edit.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, messageStream } from "../support/anthropic.ts";

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

async function grenier(...args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(BINARY, args, { cwd: repo, env: env(), timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
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
    await grenier("status");
    writeFileSync(
      join(dir, ".grenier", "config.toml"),
      [
        `[proxy]\nport = ${await freePort()}\nupstream_anthropic = "http://127.0.0.1:${(upstream.address() as AddressInfo).port}"`,
        `[store]\nembeddings = "off"`,
        `[machine]\nroutines = true\nidle_minutes = 0\nplugged_in = false\ncpu_max = 1\nmemory_max = 1`,
      ].join("\n\n"),
    );
    expect((await grenier("start")).code).toBe(0);
  });

  afterAll(async () => {
    await grenier("stop");
    await new Promise((resolve) => upstream?.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("offers the agent read tools only, and cuts the run off at an edit", async () => {
    writeFileSync(join(dir, "tidy.md"), "---\ntitle: Tidy\ntrigger: request\ntools: Edit\n---\nTidy app.ts.\n");
    const added = await grenier("routines", "add", join(dir, "tidy.md"), "--repo", repo, "--space", "me");
    const id = /\(([0-9a-f]+)\)/.exec(added.stdout)?.[1] as string;
    expect(id, added.stdout + added.stderr).toBeTruthy();
    expect((await grenier("routines", "approve", id)).code).toBe(0);

    const started = Date.now();
    const run = await grenier("routines", "run", id);
    expect(run.stdout).toMatch(/^cut, \d+ actions/m);
    expect(run.stdout).toContain("Cut off: it called Edit");
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(offered.length).toBeGreaterThan(0);
    for (const tools of offered) {
      expect(tools).not.toContain("Edit");
      expect(tools).not.toContain("Bash");
    }
    expect(readFileSync(join(repo, "app.ts"), "utf8")).toBe("export const app = 1;\n");
  }, 120_000);
});
