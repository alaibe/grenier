import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreDeps } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeWeb, REPO } from "../../../support/catalog.ts";
import { testAdmin } from "../../../support/gateway.ts";
import { storeDeps } from "../../../support/repo.ts";

describe("searching from the app", () => {
  it("says what skills.sh or the MCP Registry answered when the search fails", async () => {
    const store = openSqliteStore(":memory:");
    const home = mkdtempSync(join(tmpdir(), "grenier-catalog-"));
    try {
      const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
      const offline = (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      expect(await testAdmin(store, home, { fetch: down }).reply("GET", "/installs/search?q=notes")).toEqual({
        status: 502,
        body: { error: "skills.sh answered 503" },
      });
      expect(await testAdmin(store, home, { fetch: offline }).reply("GET", "/installs/registry?q=issues")).toEqual({
        status: 502,
        body: { error: "fetch failed" },
      });
    } finally {
      await store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("sharing a found skill", () => {
  let store: Store;
  let deps: StoreDeps;
  let home: string;

  beforeEach(async () => {
    store = openSqliteStore(":memory:");
    deps = await storeDeps(store);
    home = mkdtempSync(join(tmpdir(), "grenier-catalog-"));
  });

  afterEach(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("writes it to the team as a Skill, not installed here until approved", async () => {
    const route = testAdmin(store, home, { storeDeps: async () => deps, fetch: fakeWeb().fetchImpl }).reply;
    const share = () => route("POST", "/installs/share", { source: "acme/skills", name: "release-notes" });
    expect(await share()).toEqual({ status: 409, body: { error: "this machine is in no team: join one first" } });

    await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
    expect(await share()).toMatchObject({ status: 200, body: { title: "release-notes", files: 2, updated: false } });
    const [record] = await store.records.list({ tops: ["team"], type: "Skill" });
    expect(record?.fields.files).toEqual({ "SKILL.md": REPO["skills/notes/SKILL.md"], "template.md": "## Changes\n" });
    expect((await route("GET", "/installs", undefined))?.body).toMatchObject({
      shared: [{ title: "release-notes", state: "available" }],
    });
  });
});

describe("adding to the team from the app", () => {
  let store: Store;
  let deps: StoreDeps;
  let home: string;

  beforeEach(async () => {
    store = openSqliteStore(":memory:");
    deps = await storeDeps(store);
    home = mkdtempSync(join(tmpdir(), "grenier-catalog-"));
    await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
  });

  afterEach(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("writes a skill from its name, description and instructions", async () => {
    const route = testAdmin(store, home, { storeDeps: async () => deps }).reply;
    const add = (body: Record<string, unknown>) => route("POST", "/installs/skill", body);
    expect((await add({ name: "Release Notes", description: "x", instructions: "y" }))?.status).toBe(400);
    expect(
      await add({ name: "release-notes", description: "Writes notes.", instructions: "Read the log." }),
    ).toMatchObject({
      status: 200,
      body: { title: "release-notes" },
    });
    const [skill] = await store.records.list({ tops: ["team"], type: "Skill" });
    expect(skill?.fields.files).toEqual({
      "SKILL.md": '---\nname: release-notes\ndescription: "Writes notes."\n---\nRead the log.\n',
    });
  });

  it("quotes a description holding a colon and quotes, and reads it back as it was typed", async () => {
    const route = testAdmin(store, home, { storeDeps: async () => deps }).reply;
    const description = `Use it when: the user says "ship it" or 'release', with a \\ too.`;
    await route("POST", "/installs/skill", { name: "shipper", description, instructions: "Ship." });
    const [skill] = await store.records.list({ tops: ["team"], type: "Skill" });
    const manifest = (skill?.fields.files as Record<string, string> | undefined)?.["SKILL.md"] ?? "";
    expect(manifest.split("\n")[2]).toBe(`description: ${JSON.stringify(description)}`);
    const listed = (await route("GET", "/installs", undefined))?.body as { shared: { description: string }[] };
    expect(listed.shared[0]?.description).toBe(description);
  });

  it("adds a server by hand, refusing one that already holds a key", async () => {
    const route = testAdmin(store, home, { storeDeps: async () => deps }).reply;
    const add = (body: Record<string, unknown>) => route("POST", "/installs/server", body);
    expect((await add({ title: "leaky", config: { command: "srv", args: ["--token", "abc"] } }))?.status).toBe(409);
    expect(
      (
        await add({
          title: "leaky",
          config: {
            url: "https://x.test/mcp",
            headers: { Authorization: "Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
          },
        })
      )?.status,
    ).toBe(409);
    expect(
      await add({
        title: "linear",
        description: "Issues.",
        config: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer {api_key}" } },
        credentials: ["api_key"],
      }),
    ).toMatchObject({ status: 200 });
    const [server] = await store.records.list({ tops: ["team"], type: "McpServer" });
    expect(server?.fields).toEqual({
      config: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer {api_key}" } },
      credentials: ["api_key"],
    });
  });
});
