import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@grenier/core";
import { createGateway } from "@grenier/gateway";
import { loadPrices } from "@grenier/log";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TOKEN = "ga_admin-test";
let store: Store;
let dir: string;
let app: ReturnType<typeof createGateway>;

beforeEach(() => {
  store = openSqliteStore(":memory:");
  dir = mkdtempSync(join(tmpdir(), "grenier-admin-"));
  writeFileSync(join(dir, "plans.md"), "# Plans\n\nShip the desktop app.\n");
  app = createGateway({
    store,
    config: defaultConfig(),
    prices: loadPrices(),
    port: 7788,
    admin: { token: TOKEN, version: "test" },
  });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(path: string, init: RequestInit & { origin?: string } = {}) {
  const { origin, ...rest } = init;
  return app.request(`http://127.0.0.1:7788/admin${path}`, {
    ...rest,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

describe("the admin API", () => {
  it("needs the admin token", async () => {
    expect((await app.request("http://127.0.0.1:7788/admin/overview")).status).toBe(401);
    expect((await call("/overview", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call("/overview")).status).toBe(200);
  });

  it("answers the desktop app's origin with CORS, and no other", async () => {
    const preflight = await app.request("http://127.0.0.1:7788/admin/overview", {
      method: "OPTIONS",
      headers: { origin: "tauri://localhost" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect((await call("/overview", { origin: "tauri://localhost" })).headers.get("access-control-allow-origin")).toBe(
      "tauri://localhost",
    );
    const evil = await app.request("http://127.0.0.1:7788/admin/overview", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    expect(
      (await call("/overview", { origin: "https://evil.example" })).headers.get("access-control-allow-origin"),
    ).toBeNull();
  });

  it("adds a source, syncs it, and lists it without anything secret", async () => {
    const added = await call("/sources", {
      method: "POST",
      body: JSON.stringify({ kind: "markdown", name: "journal", path: dir }),
    });
    expect(added.status).toBe(201);
    expect(((await added.json()) as { sync: { added: number } }).sync.added).toBe(1);

    await call("/sources", {
      method: "POST",
      body: JSON.stringify({
        kind: "imap",
        name: "mail",
        host: "imap.example.org",
        user: "ada",
        password_command: "false",
      }),
    });
    const refusedName = await call("/sources", {
      method: "POST",
      body: JSON.stringify({
        kind: "imap",
        name: "work",
        host: "imap.example.org",
        user: "ada",
        password_command: "false",
      }),
    });
    expect(refusedName.status).toBe(201);

    const listed = (await (await call("/sources")).json()) as {
      sources: { name: string; items: number; config: object }[];
    };
    expect(listed.sources.find((source) => source.name === "journal")?.items).toBe(1);
    expect(JSON.stringify(listed)).not.toContain("password");
    expect((await call("/sources/journal", { method: "DELETE" })).status).toBe(200);
  });

  it("refuses a source named after a kind, or without what its kind needs", async () => {
    expect(
      (await call("/sources", { method: "POST", body: JSON.stringify({ kind: "markdown", name: "notes", path: dir }) }))
        .status,
    ).toBe(400);
    const missing = await call("/sources", {
      method: "POST",
      body: JSON.stringify({ kind: "caldav", name: "cal", url: "https://x" }),
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain("username");
  });

  it("creates, lists and revokes clients, with known scopes only", async () => {
    const created = await call("/clients", {
      method: "POST",
      body: JSON.stringify({ name: "claude", scopes: ["notes"] }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { token: string }).token).toMatch(/^gc_/);
    expect(
      (await call("/clients", { method: "POST", body: JSON.stringify({ name: "x", scopes: ["secrets"] }) })).status,
    ).toBe(400);
    expect(
      ((await (await call("/clients")).json()) as { clients: { name: string }[] }).clients.map((c) => c.name),
    ).toEqual(["claude"]);
    expect((await call("/clients/claude/revoke", { method: "POST" })).status).toBe(200);
    expect(((await (await call("/clients")).json()) as { clients: unknown[] }).clients).toEqual([]);
  });

  it("shows the audit log and decides on the review queue", async () => {
    await store.audit.add({ ts: Date.now(), clientId: "c1", tool: "search", args: { query: "x" }, itemIds: ["a"] });
    expect(
      ((await (await call("/audit")).json()) as { entries: { tool: string }[] }).entries.map((e) => e.tool),
    ).toEqual(["search"]);

    await store.review.add({ id: "r1", clientId: "c1", text: "Remember this.", tags: [], ts: 1 });
    await store.review.add({ id: "r2", clientId: "c1", text: "Not this.", tags: [], ts: 2 });
    expect(((await (await call("/review")).json()) as { pending: unknown[] }).pending).toHaveLength(2);
    expect((await call("/review/r1/approve", { method: "POST" })).status).toBe(200);
    expect((await call("/review/r2/reject", { method: "POST" })).status).toBe(200);
    expect((await call("/review/r2/reject", { method: "POST" })).status).toBe(404);
    expect((await store.items.get("memory:r1"))?.body).toBe("Remember this.");
  });

  it("gives the overview and the reports", async () => {
    await store.usage.add({ sessionId: "s", ts: Date.now(), model: "claude-opus-5-5", inputTokens: 10, cost: 0.1 });
    const overview = (await (await call("/overview")).json()) as { version: string; days: { requests: number }[] };
    expect(overview.version).toBe("test");
    expect(overview.days[0]?.requests).toBe(1);
    expect((await call("/report?by=week")).status).toBe(400);
    expect((await call("/report?since=forever")).status).toBe(400);
  });
});
