import { createMcpServer } from "@grenier/gateway";
import { type Reader, remember } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADA, gitFiles, storeDeps, TestRepo } from "../../support/repo.ts";

let store: Store;
let repo: TestRepo;
const ids: Record<string, string> = {};

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  repo = new TestRepo({ "src/budget.ts": "export const review = () => 'Friday';\n" });
  await repo.ready();
  const deps = await storeDeps(store);
  for (const space of ["team", "space:leads"]) {
    await store.spaces.put({
      id: space,
      name: space,
      kind: space === "team" ? "team" : "custom",
      repoId: null,
      root: null,
    });
  }
  const person = { id: "p", name: "p", scopes: ["*"] };
  ids.team = (
    await remember(deps, person, null, {
      kind: "fact",
      title: "Budget review with Marie",
      body: "On Friday.",
      space: "team",
    })
  ).id;
  ids.leads = (
    await remember(deps, person, null, {
      kind: "fact",
      title: "Budget review salaries",
      body: "Friday, leads only.",
      space: "space:leads",
    })
  ).id;
  ids.me = (
    await remember(deps, person, null, {
      kind: "fact",
      title: "Budget review notes for me",
      body: "Friday.",
      space: "me",
    })
  ).id;
  ids.repo = (
    await remember(deps, null, repo.repo, {
      kind: "answer",
      title: "Where is the budget review?",
      body: "In budget.ts, on Friday.",
      files: ["src/budget.ts"],
    })
  ).id;
});

afterEach(async () => {
  await store.close();
  repo.remove();
});

async function connect(reader: Reader | null) {
  const server = createMcpServer({
    store,
    files: gitFiles,
    embedder: async () => null,
    resolveRepo: async () => repo.repo,
    reader: async () => reader,
    me: async () => ADA,
    version: "test",
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientSide);
  return client;
}

const reader = (scopes: string[]): Reader => ({ id: `client-${scopes.join("-") || "none"}`, name: "app", scopes });

/** Every read tool, called so that it would return everything a full scope can see. */
const READS = [
  { name: "recall", args: { query: "budget review Friday", limit: 20 } },
  { name: "query", args: { type: "Memory" } },
  { name: "query", args: { id: "" } },
  { name: "query", args: { title: "Budget review salaries" } },
] as const;

async function idsFrom(client: Client, name: string, args: Record<string, unknown>): Promise<string[]> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.structuredContent as
    | { results?: { id: string }[]; records?: { id: string }[]; linked?: { id: string }[] }
    | undefined;
  return [...(content?.results ?? []), ...(content?.records ?? []), ...(content?.linked ?? [])].map(
    (record) => record.id,
  );
}

async function readsOf(client: Client): Promise<Set<string>> {
  const seen = new Set<string>();
  for (const read of READS) {
    for (const id of Object.values(ids)) {
      const args = "id" in read.args ? { id } : read.args;
      for (const found of await idsFrom(client, read.name, args)) seen.add(found);
    }
  }
  return seen;
}

describe("scopes, against every read tool", () => {
  const cases: [string, Reader | null, string[]][] = [
    ["a connection without a client", null, ["repo"]],
    ["a client scoped to team", reader(["team"]), ["team", "repo"]],
    ["a client scoped to me", reader(["me"]), ["me", "repo"]],
    ["a client scoped to a custom space", reader(["space:leads"]), ["leads", "repo"]],
    ["a client scoped to every space", reader(["*"]), ["team", "leads", "me", "repo"]],
    ["a client with an empty scope", reader([]), ["repo"]],
  ];
  for (const [label, client, allowed] of cases) {
    it(`gives ${label} only ${allowed.join(", ") || "nothing"}`, async () => {
      const seen = await readsOf(await connect(client));
      const expected = new Set(allowed.map((key) => ids[key] as string));
      expect([...seen].sort()).toEqual([...expected].sort());
    });
  }

  it("answers query for a record out of scope exactly as for one that does not exist", async () => {
    const client = await connect(reader(["team"]));
    const outside = await client.callTool({ name: "query", arguments: { id: ids.me } });
    const missing = await client.callTool({ name: "query", arguments: { id: "nothing" } });
    expect(outside.structuredContent).toMatchObject({ records: [] });
    expect(JSON.stringify(outside.content).replace(ids.me as string, "X")).toBe(
      JSON.stringify(missing.content).replace("nothing", "X"),
    );
  });
});

describe("what a read returns", () => {
  it("writes an audit row with the client, the tool, its arguments and every record returned", async () => {
    const client = await connect(reader(["team"]));
    await client.callTool({ name: "recall", arguments: { query: "budget review Marie" } });
    const entries = await store.audit.list();
    expect(entries).toMatchObject([
      { tool: "recall", clientId: "client-team", args: { query: "budget review Marie" } },
    ]);
    expect(entries[0]?.recordIds.sort()).toEqual([ids.team, ids.repo].sort());
  });

  it("marks every record's text as untrusted data", async () => {
    const client = await connect(reader(["*"]));
    const result = await client.callTool({ name: "recall", arguments: { query: "budget review Marie" } });
    const body = (result.structuredContent as { results: { body: string }[] }).results[0]?.body ?? "";
    expect(body).toMatch(/^<untrusted-data-[0-9a-f]{12} id="\w+" author="ada">\n/);
  });
});
