import { defaultConfig, sha256 } from "@grenier/core";
import { createGateway, createMcpServer } from "@grenier/gateway";
import { gitFiles } from "@grenier/git";
import { type Reader, StoreUseError } from "@grenier/index";
import { loadPrices } from "@grenier/log";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADA, TestRepo } from "../../support/repo.ts";

let store: Store;
let repo: TestRepo;

beforeEach(async () => {
  repo = new TestRepo({ "proxy.ts": "export const proxy = 1;\n" });
  await repo.ready();
  store = openSqliteStore(":memory:");
  await store.state.set("team_member", "ada");
});

afterEach(async () => {
  await store.close();
  repo.remove();
});

const resolveRepo = async (path: string | undefined) => {
  if (path !== undefined && path !== repo.dir) throw new StoreUseError(`not inside a git repository: ${path}`);
  return repo.repo;
};

async function connect(options: { reader?: Reader | null; runTop?: string; texts?: Record<string, string> } = {}) {
  const server = createMcpServer({
    store,
    files: gitFiles,
    embedder: async () => null,
    resolveRepo,
    reader: async () => options.reader ?? { id: "c", name: "claude", scopes: ["*"] },
    me: async () => ADA,
    version: "test",
    ...(options.runTop ? { runTop: options.runTop } : {}),
    ...(options.texts ? { texts: () => options.texts as Record<string, string> } : {}),
  });
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
  it("offers get and set, with the person's own texts where they wrote them", async () => {
    const plain = await connect();
    expect((await plain.listTools()).tools.map((tool) => tool.name)).toEqual(["get", "set"]);
    const own = await connect({ texts: { mcp: "Our store.", get: "Ask it first." } });
    expect(own.getInstructions()).toBe("Our store.");
    const tools = (await own.listTools()).tools;
    expect(tools.find((tool) => tool.name === "get")?.description).toBe("Ask it first.");
    expect(tools.find((tool) => tool.name === "set")?.description).toContain("Save, short");
  });

  it("follows the protocol's folders: Team's runbooks before their first page, and Me/About", async () => {
    const client = await connect();
    const name = repo.dir.split("/").at(-1) as string;
    expect(
      structured(await client.callTool({ name: "get", arguments: { folder: `Team/${name}/Runbooks` } })),
    ).toMatchObject({ records: [] });
    const draft = structured(
      await client.callTool({
        name: "set",
        arguments: { title: "Release", body: "Tag it; the nightly ships it.", folder: `Me/${name}` },
      }),
    );
    expect(draft).toMatchObject({ top: "me" });
    const about = structured(
      await client.callTool({
        name: "set",
        arguments: { title: "Ada", body: "Prefers short answers.", folder: "Me/About" },
      }),
    );
    expect(about).toMatchObject({ top: "me" });
    expect(structured(await client.callTool({ name: "get", arguments: { folder: "Me/About" } }))).toMatchObject({
      records: [{ title: "Ada" }],
    });
  });

  it("answers get from what set kept", async () => {
    const client = await connect();
    const question = "Where is the proxy defined?";
    expect(structured(await client.callTool({ name: "get", arguments: { query: question } }))).toMatchObject({
      status: "miss",
    });
    const kept = structured(
      await client.callTool({
        name: "set",
        arguments: { title: question, body: "In proxy.ts.", files: ["proxy.ts"] },
      }),
    );
    expect(kept).toMatchObject({ top: "me" });
    const got = structured(await client.callTool({ name: "get", arguments: { query: question } }));
    expect(got).toMatchObject({ status: "hit", results: [{ title: question, changed: [] }] });
    expect(structured(await client.callTool({ name: "get", arguments: { id: kept.id } }))).toMatchObject({
      records: [{ title: question }],
    });
    expect((await client.callTool({ name: "get", arguments: {} })).isError).toBe(true);
  });

  it("keeps anything but an answer about the code in me, without asking, and never writes the team's", async () => {
    const client = await connect();
    const kept = structured(
      await client.callTool({
        name: "set",
        arguments: { title: "Use SQLite", body: "One file." },
      }),
    );
    expect(kept).toMatchObject({ top: "me" });
    const toTeam = await client.callTool({ name: "set", arguments: { title: "x", folder: "Team" } });
    expect((toTeam as { content: { text: string }[] }).content[0]?.text).toContain("set keeps a page in Me");
    const {
      seq: _seq,
      hits: _hits,
      ...mine
    } = (await store.records.get(kept.id as string)) as NonNullable<Awaited<ReturnType<Store["records"]["get"]>>>;
    await store.records.put({ ...mine, id: "shared", top: "team", version: 1 });
    const change = await client.callTool({ name: "set", arguments: { id: "shared", title: "y" } });
    expect((change as { content: { text: string }[] }).content[0]?.text).toContain("the team's");
  });

  it("keeps a run's pages where its approval says, and refuses a member's run a page for the team", async () => {
    const about = (title: string) => ({ title, body: "In proxy.ts.", files: ["proxy.ts"] });
    const kept = async (client: Awaited<ReturnType<typeof connect>>, args: Record<string, unknown>) =>
      structured(await client.callTool({ name: "set", arguments: args }))?.top;
    const run = await connect({ runTop: "team" });
    expect(await kept(run, about("Where is the proxy?"))).toBe("team");
    expect(await kept(run, { title: "The proxy listens on 7788" })).toBe("team");
    const collector = await connect({ runTop: "me" });
    expect(await kept(collector, about("Who calls the proxy?"))).toBe("me");

    await store.state.set("team_role", "member");
    const member = await connect({ runTop: "team" });
    const refused = await member.callTool({ name: "set", arguments: about("What does the proxy do?") });
    expect(refused.isError).toBe(true);
    expect((refused as { content: { text: string }[] }).content[0]?.text).toContain("only an admin writes in Team");
  });

  it("returns the store's refusals as tool errors, not crashes", async () => {
    const client = await connect();
    const outside = await client.callTool({
      name: "set",
      arguments: { title: "q", body: "a", files: ["../../etc/passwd"] },
    });
    expect(outside.isError).toBe(true);
    expect((outside as { content: { text: string }[] }).content[0]?.text).toContain("outside the repository");
    const elsewhere = await client.callTool({ name: "get", arguments: { query: "q", repo: "/nowhere" } });
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
      admin: new Hono(),
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
