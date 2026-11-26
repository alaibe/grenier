import { defaultConfig, sha256 } from "@grenier/core";
import { createGateway, createMcpServer } from "@grenier/gateway";
import { gitFiles } from "@grenier/git";
import { type Reader, StoreUseError } from "@grenier/index";
import { loadPrices } from "@grenier/log";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADA, TestRepo } from "../../support/repo.ts";

let store: Store;
let repo: TestRepo;

beforeEach(async () => {
  repo = new TestRepo({ "proxy.ts": "export const proxy = 1;\n" });
  await repo.ready();
  store = openSqliteStore(":memory:");
  await store.tops.put({ id: "me", name: "me", kind: "me", repoId: null, root: null });
  await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
});

afterEach(async () => {
  await store.close();
  repo.remove();
});

const resolveRepo = async (path: string | undefined) => {
  if (path !== undefined && path !== repo.dir) throw new StoreUseError(`not inside a git repository: ${path}`);
  return repo.repo;
};

async function connect(
  options: { reader?: Reader | null; elicit?: (message: string) => unknown; runTop?: string } = {},
) {
  const server = createMcpServer({
    store,
    files: gitFiles,
    embedder: async () => null,
    resolveRepo,
    reader: async () => options.reader ?? { id: "c", name: "claude", scopes: ["*"] },
    me: async () => ADA,
    version: "test",
    ...(options.runTop ? { runTop: options.runTop } : {}),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client(
    { name: "test", version: "1" },
    options.elicit ? { capabilities: { elicitation: {} } } : {},
  );
  if (options.elicit) {
    const elicit = options.elicit;
    client.setRequestHandler(ElicitRequestSchema, async (request) => elicit(request.params.message) as never);
  }
  await client.connect(clientSide);
  return client;
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe("the MCP server", () => {
  it("answers recall from what remember kept", async () => {
    const client = await connect();
    const question = "Where is the proxy defined?";
    expect(structured(await client.callTool({ name: "recall", arguments: { query: question } }))).toMatchObject({
      status: "miss",
    });
    const kept = structured(
      await client.callTool({
        name: "remember",
        arguments: { kind: "answer", title: question, body: "In proxy.ts.", files: ["proxy.ts"] },
      }),
    );
    expect(kept).toMatchObject({ status: "kept", top: `repo:${repo.repo.id}` });
    const recalled = structured(await client.callTool({ name: "recall", arguments: { query: question } }));
    expect(recalled).toMatchObject({ status: "hit", results: [{ title: question, changed: [] }] });
  });

  it("asks the person before a decision leaves this machine, and keeps it in me when they say so", async () => {
    const asked: string[] = [];
    const client = await connect({
      elicit: (message) => {
        asked.push(message);
        return { action: "accept", content: { choice: "me" } };
      },
    });
    const kept = structured(
      await client.callTool({
        name: "remember",
        arguments: {
          type: "Decision",
          title: "Use SQLite",
          fields: { owner: "ada", date: "2026-11-20", reason: "One file." },
        },
      }),
    );
    expect(asked[0]).toContain("Share this Decision with the whole team?");
    expect(kept).toMatchObject({ top: "me", status: "kept in me" });
  });

  it("keeps a record in me when the client cannot ask", async () => {
    const client = await connect();
    const kept = structured(
      await client.callTool({ name: "remember", arguments: { kind: "convention", title: "Tabs" } }),
    );
    expect(kept).toMatchObject({ top: "me" });
  });

  it("keeps a run's answer about the code in its repository's folder, and a member's run's other records nowhere", async () => {
    const about = (title: string) => ({ kind: "answer", title, body: "In proxy.ts.", files: ["proxy.ts"] });
    const kept = async (client: Awaited<ReturnType<typeof connect>>, args: Record<string, unknown>) =>
      structured(await client.callTool({ name: "remember", arguments: args }))?.top;
    const run = await connect({ runTop: "team" });
    expect(await kept(run, about("Where is the proxy?"))).toBe(`repo:${repo.repo.id}`);
    expect(await kept(run, { kind: "fact", title: "The proxy listens on 7788" })).toBe("team");
    const collector = await connect({ runTop: "me" });
    expect(await kept(collector, about("Who calls the proxy?"))).toBe("me");

    await store.state.set("team_role", "member");
    const member = await connect({ runTop: "team" });
    expect(await kept(member, about("What does the proxy do?"))).toBe(`repo:${repo.repo.id}`);
    const fact = await member.callTool({
      name: "remember",
      arguments: { kind: "fact", title: "It restarts at night" },
    });
    expect(fact.isError).toBe(true);
    expect((fact as { content: { text: string }[] }).content[0]?.text).toContain("run on a member's machine");
  });

  it("returns the store's refusals as tool errors, not crashes", async () => {
    const client = await connect();
    const outside = await client.callTool({
      name: "remember",
      arguments: { kind: "answer", title: "q", body: "a", files: ["../../etc/passwd"] },
    });
    expect(outside.isError).toBe(true);
    expect((outside as { content: { text: string }[] }).content[0]?.text).toContain("outside the repository");
    const elsewhere = await client.callTool({ name: "recall", arguments: { query: "q", repo: "/nowhere" } });
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
      mcp: { files: gitFiles, embedder: async () => null, resolveRepo, me: async () => ADA, version: "test" },
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
