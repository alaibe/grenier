import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobHashes, repoPath, trackedFiles } from "@grenier/connectors/git";
import { defaultConfig, sha256 } from "@grenier/core";
import { createGateway, createMcpServer, INSTRUCTIONS } from "@grenier/gateway";
import { CacheError } from "@grenier/index";
import { loadPrices } from "@grenier/log";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-mcp-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@x.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@x.invalid",
      },
    });
  git("init", "-q");
  writeFileSync(join(dir, "proxy.ts"), "export const proxy = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  store = openSqliteStore(":memory:");
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const files = { hashes: blobHashes, tracked: trackedFiles, relative: repoPath };
const resolveRepo = async (repo: string | undefined) => {
  if (repo !== undefined && repo !== dir) throw new CacheError(`not inside a git repository: ${repo}`);
  return { root: dir, id: "repo-1" };
};

async function connect() {
  const server = createMcpServer({ store, files, embedder: async () => null, resolveRepo, version: "test" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe("the MCP server", () => {
  it("tells the agent to ask before exploring and to record after", async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS).toContain("call ask_codebase");
    expect(INSTRUCTIONS).toContain("call record_answer");
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "ask_codebase",
      "file_summary",
      "record_answer",
      "record_summary",
      "repo_map",
    ]);
  });

  it("answers ask_codebase from what record_answer kept", async () => {
    const client = await connect();
    const question = "Where is the proxy defined?";
    expect(structured(await client.callTool({ name: "ask_codebase", arguments: { question } }))).toMatchObject({
      status: "miss",
    });

    const recorded = structured(
      await client.callTool({
        name: "record_answer",
        arguments: { question, answer: "In proxy.ts.", files: ["proxy.ts"] },
      }),
    );
    expect(recorded.id).toEqual(expect.any(String));

    const asked = await client.callTool({ name: "ask_codebase", arguments: { question } });
    expect(structured(asked)).toMatchObject({ status: "hit", answer: "In proxy.ts.", changed: [] });
    expect(JSON.parse((asked as { content: { text: string }[] }).content[0]?.text ?? "{}").status).toBe("hit");
  });

  it("records and reads summaries, and maps the repository", async () => {
    const client = await connect();
    await client.callTool({ name: "record_summary", arguments: { path: "proxy.ts", summary: "Exports the proxy." } });
    expect(structured(await client.callTool({ name: "file_summary", arguments: { path: "proxy.ts" } }))).toEqual({
      status: "hit",
      path: "proxy.ts",
      summary: "Exports the proxy.",
    });
    expect(structured(await client.callTool({ name: "repo_map", arguments: {} }))).toEqual({
      entries: [{ path: "proxy.ts", kind: "file", files: 1, summary: "Exports the proxy.", stale: false }],
    });
  });

  it("returns the cache's refusals as tool errors, not crashes", async () => {
    const client = await connect();
    const outside = await client.callTool({
      name: "record_answer",
      arguments: { question: "q", answer: "a", files: ["../../etc/passwd"] },
    });
    expect(outside.isError).toBe(true);
    expect((outside as { content: { text: string }[] }).content[0]?.text).toContain("outside the repository");

    const elsewhere = await client.callTool({ name: "ask_codebase", arguments: { question: "q", repo: "/nowhere" } });
    expect(elsewhere.isError).toBe(true);
  });
});

describe("MCP over HTTP in the daemon", () => {
  function gateway() {
    return createGateway({
      store,
      config: defaultConfig(),
      prices: loadPrices(),
      port: 7788,
      mcp: { files, embedder: async () => null, resolveRepo, version: "test" },
    });
  }

  const initialize = (token?: string) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  });

  it("refuses a request without a valid, unrevoked client token", async () => {
    const app = gateway();
    await store.clients.add({ id: "c1", name: "app", tokenHash: await sha256("good-token"), scopes: [], createdAt: 0 });

    expect((await app.request("http://127.0.0.1:7788/mcp", initialize())).status).toBe(401);
    expect((await app.request("http://127.0.0.1:7788/mcp", initialize("wrong"))).status).toBe(401);

    const ok = await app.request("http://127.0.0.1:7788/mcp", initialize("good-token"));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("grenier");

    await store.clients.revoke("app", 1);
    expect((await app.request("http://127.0.0.1:7788/mcp", initialize("good-token"))).status).toBe(401);
  });
});
