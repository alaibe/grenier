import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
  writeFileSync(join(home, "config.toml"), `[proxy]\nport = ${port}\n\n[store]\nembeddings = "off"\n`);
});

afterAll(async () => {
  await grenier("stop").catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe("the MCP server of the built binary", () => {
  it("answers recall over stdio: miss, then hit after remember, then stale after an edit", async () => {
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
      expect(structured(await client.callTool({ name: "recall", arguments: { query: question } })).status).toBe("miss");
      await client.callTool({
        name: "remember",
        arguments: { kind: "answer", title: question, body: "In proxy.ts.", files: ["proxy.ts"] },
      });
      expect(structured(await client.callTool({ name: "recall", arguments: { query: question } }))).toMatchObject({
        status: "hit",
        results: [{ title: question }],
      });

      writeFileSync(join(repo, "proxy.ts"), "export const proxy = 2;\n");
      expect(structured(await client.callTool({ name: "recall", arguments: { query: question } }))).toMatchObject({
        status: "stale",
        results: [{ changed: ["proxy.ts"] }],
      });
      writeFileSync(join(repo, "proxy.ts"), "export const proxy = 1;\n");
    } finally {
      await client.close();
    }
  });
});
