import { defaultConfig, sha256 } from "@grenier/core";
import { createGateway, createMcpServer } from "@grenier/gateway";
import { type Reader, StoreUseError } from "@grenier/index";
import { loadPrices } from "@grenier/log";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADA, gitFiles, TestRepo } from "../../support/repo.ts";

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

  it("files a request for a routine, by its title, once the person says yes", async () => {
    const asked: string[] = [];
    let filing = "file";
    const client = await connect({
      elicit: (message) => {
        asked.push(message);
        return { action: "accept", content: { choice: message.startsWith("Share") ? "share" : filing } };
      },
    });
    await client.callTool({
      name: "remember",
      arguments: { type: "Routine", title: "Update dependencies", body: "Update.", fields: { trigger: "request" } },
    });
    const filed = structured(
      await client.callTool({ name: "request", arguments: { routine: "update dependencies", title: "Bump hono" } }),
    );
    expect(filed).toMatchObject({ routine: "Update dependencies", status: "to-do" });
    expect(asked.at(-1)).toContain("File this request for Update dependencies?");
    expect((await store.records.get(String(filed.id)))?.fields).toMatchObject({ status: "to-do" });
    const unknown = await client.callTool({ name: "request", arguments: { routine: "nothing", title: "x" } });
    expect(unknown.isError).toBe(true);
    const before = asked.length;
    const secret = await client.callTool({
      name: "request",
      arguments: { routine: "update dependencies", title: "Bump hono", body: "Use AKIAABCDEFGHIJKLMNOP to publish." },
    });
    expect(secret.isError).toBe(true);
    expect(asked).toHaveLength(before);
    expect((await store.outbox.list()).some((entry) => JSON.stringify(entry.change).includes("AKIA"))).toBe(false);

    filing = "cancel";
    const declined = await client.callTool({
      name: "request",
      arguments: { routine: "update dependencies", title: "Not this one" },
    });
    expect(declined.isError).toBe(true);
    const tasks = await store.records.list({ tops: ["team"], type: "Task" });
    expect(tasks.map((task) => task.title)).toEqual(["Bump hono"]);
  });

  it("files no request from a client that cannot ask the person, nor one a member may not file", async () => {
    const admin = await connect({ elicit: () => ({ action: "accept", content: { choice: "share" } }) });
    await admin.callTool({
      name: "remember",
      arguments: { type: "Routine", title: "Tidy", body: "Tidy.", fields: { trigger: "request" } },
    });
    const silent = await connect();
    const refused = await silent.callTool({
      name: "request",
      arguments: { routine: "Tidy", title: "Tidy the readme" },
    });
    expect((refused as { content: { text: string }[] }).content[0]?.text).toContain("cannot ask you first");
    await store.state.set("team_role", "member");
    const asked: string[] = [];
    const member = await connect({
      elicit: (message) => {
        asked.push(message);
        return { action: "accept", content: { choice: "file" } };
      },
    });
    expect((await member.callTool({ name: "request", arguments: { routine: "Tidy", title: "Tidy" } })).isError).toBe(
      true,
    );
    expect(asked).toEqual([]);
    expect(await store.records.list({ tops: ["team"], type: "Task" })).toEqual([]);
  });

  it("files a request from a routine's run without asking: no one watches a run", async () => {
    await store.records.put({
      id: "r1",
      top: "team",
      type: "Routine",
      kind: null,
      title: "Tidy",
      folder: "",
      body: "Tidy.",
      fields: { trigger: "request" },
      author: "ada",
      device: null,
      sessionId: null,
      createdAt: 1,
      updatedAt: 1,
      retiredAt: null,
      version: 1,
      anchors: [],
      links: [],
    });
    const run = await connect({ runTop: "team" });
    const filed = structured(await run.callTool({ name: "request", arguments: { routine: "Tidy", title: "Again" } }));
    expect(filed).toMatchObject({ status: "to-do" });
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
