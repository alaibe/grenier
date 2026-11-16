import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openSqliteStore } from "@grenier/store/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));

let dir: string;
let repo: string;
let home: string;
let port: number;

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

async function grenier(...args: string[]) {
  return promisify(execFile)(BINARY, args, { cwd: repo, env: { PATH: process.env.PATH, GRENIER_HOME: home } });
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-e2e-mcp-")));
  repo = join(dir, "app");
  home = join(dir, ".grenier");
  mkdirSync(repo);
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
  writeFileSync(join(repo, "proxy.ts"), "export const proxy = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");

  const free = createServer();
  await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
  port = (free.address() as AddressInfo).port;
  await new Promise((resolve) => free.close(resolve));

  await grenier("status");
  writeFileSync(join(home, "config.toml"), `[proxy]\nport = ${port}\n\n[cache]\nembeddings = "off"\n`);
});

afterAll(async () => {
  await grenier("stop").catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe("the MCP server of the built binary", () => {
  it("answers ask_codebase over stdio: miss, then hit after record_answer, then stale after an edit", async () => {
    const transport = new StdioClientTransport({
      command: BINARY,
      args: ["mcp", "serve"],
      cwd: repo,
      env: { PATH: process.env.PATH ?? "", GRENIER_HOME: home },
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e", version: "1" });
    await client.connect(transport);
    try {
      const question = "Where is the proxy defined?";
      expect(structured(await client.callTool({ name: "ask_codebase", arguments: { question } })).status).toBe("miss");
      await client.callTool({
        name: "record_answer",
        arguments: { question, answer: "In proxy.ts.", files: ["proxy.ts"] },
      });
      expect(structured(await client.callTool({ name: "ask_codebase", arguments: { question } }))).toMatchObject({
        status: "hit",
        answer: "In proxy.ts.",
      });

      writeFileSync(join(repo, "proxy.ts"), "export const proxy = 2;\n");
      expect(structured(await client.callTool({ name: "ask_codebase", arguments: { question } }))).toMatchObject({
        status: "stale",
        changed: ["proxy.ts"],
      });
      writeFileSync(join(repo, "proxy.ts"), "export const proxy = 1;\n");
    } finally {
      await client.close();
    }
  });

  it("answers over HTTP through the daemon for a client with a token, from the same cache", async () => {
    await grenier("start");
    const store = openSqliteStore(join(home, "grenier.db"));
    const token = "e2e-client-token";
    await store.clients.add({
      id: "c1",
      name: "e2e",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      scopes: [],
      createdAt: Date.now(),
    });
    await store.close();

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "e2e-http", version: "1" });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "ask_codebase",
        arguments: { question: "Where is the proxy defined?", repo },
      });
      expect(structured(result)).toMatchObject({ status: "hit", answer: "In proxy.ts." });
      const withoutRepo = await client.callTool({ name: "ask_codebase", arguments: { question: "x" } });
      expect(withoutRepo.isError).toBe(true);
    } finally {
      await client.close();
    }

    const refused = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
    expect(refused.status).toBe(401);
  });

  it("shows and clears the cache", async () => {
    expect((await grenier("cache", "stats")).stdout).toMatch(/^\S+\s+1\s+\d+\s+0$/m);
    expect((await grenier("cache", "clear", "--repo", repo)).stdout).toBe("Removed 1 answer(s) and 0 summary(ies).\n");
    expect((await grenier("cache", "stats")).stdout).toBe("The cache is empty.\n");
  });
});
