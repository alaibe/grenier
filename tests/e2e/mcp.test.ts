import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "@grenier/core/node";
import { addClient } from "@grenier/index";
import { openSqliteStore } from "@grenier/store/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));

let dir: string;
let repo: string;
let home: string;
let port: number;
let token: string;

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
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

  mkdirSync(home, { recursive: true });
  writeFileSync(
    resolvePaths({ GRENIER_HOME: home }).config,
    `[proxy]\nport = ${port}\n\n[store]\nembeddings = "off"\n`,
  );
  // The token the app writes into an agent's config when it adds Grenier.
  const store = openSqliteStore(resolvePaths({ GRENIER_HOME: home }).db);
  token = await addClient(store, "e2e", ["*"]);
  await store.close();
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the MCP server of the built binary", () => {
  it("answers recall over stdio: miss, then hit after remember, then stale after an edit", async () => {
    const transport = new StdioClientTransport({
      command: BINARY,
      args: ["mcp", "serve"],
      cwd: repo,
      env: { PATH: process.env.PATH ?? "", GRENIER_HOME: home, GRENIER_CLIENT_TOKEN: token },
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e", version: "1" });
    await client.connect(transport);
    try {
      const question = "Where is the proxy defined?";
      expect(structured(await client.callTool({ name: "get", arguments: { query: question } })).status).toBe("miss");
      await client.callTool({
        name: "set",
        arguments: { title: question, body: "In proxy.ts.", files: ["proxy.ts"] },
      });
      expect(structured(await client.callTool({ name: "get", arguments: { query: question } }))).toMatchObject({
        status: "hit",
        results: [{ title: question }],
      });

      writeFileSync(join(repo, "proxy.ts"), "export const proxy = 2;\n");
      expect(structured(await client.callTool({ name: "get", arguments: { query: question } }))).toMatchObject({
        status: "stale",
        results: [{ changed: ["proxy.ts"] }],
      });
      writeFileSync(join(repo, "proxy.ts"), "export const proxy = 1;\n");
    } finally {
      await client.close();
    }
  });
});
