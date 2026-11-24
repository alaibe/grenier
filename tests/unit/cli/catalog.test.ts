import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreDeps } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchSkill, searchServers, searchSkills } from "../../../apps/cli/src/catalog.ts";
import { installs } from "../../../apps/cli/src/host.ts";
import { storeDeps } from "../../support/repo.ts";

const SHA = "a1b2c3";
const REPO: Record<string, string> = {
  "README.md": "# Skills\n",
  "skills/notes/SKILL.md": "---\nname: release-notes\ndescription: Writes release notes.\n---\nRead the log.\n",
  "skills/notes/template.md": "## Changes\n",
  "skills/notes/.env": "TOKEN=1\n",
  "skills/other/SKILL.md": "---\nname: other\n---\nSomething else.\n",
};

/** Answers like skills.sh, GitHub's API and raw.githubusercontent.com, and records each URL it was asked. */
function fakeWeb(repo: Record<string, string> = REPO) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    if (url.startsWith("https://skills.sh/api/search?")) {
      return Response.json({
        skills: [
          { id: "acme/skills/release-notes", name: "release-notes", installs: 1200, source: "acme/skills" },
          { id: "acme/tools/lint", name: "lint", installs: 3, source: "" },
          { id: "x", name: "bad source", installs: 1, source: "not a repo" },
          { name: "no id" },
        ],
      });
    }
    if (url === "https://api.github.com/repos/acme/skills/commits/HEAD") return Response.json({ sha: SHA });
    if (url === `https://api.github.com/repos/acme/skills/git/trees/${SHA}?recursive=1`) {
      return Response.json({
        tree: Object.entries(repo).map(([path, text]) => ({ path, type: "blob", size: text.length })),
      });
    }
    const raw = `https://raw.githubusercontent.com/acme/skills/${SHA}/`;
    if (url.startsWith(raw) && repo[url.slice(raw.length)] !== undefined)
      return new Response(repo[url.slice(raw.length)]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

describe("searching skills.sh", () => {
  it("sends only the words, and keeps the results that name a skill and its GitHub repository", async () => {
    const { asked, fetchImpl } = fakeWeb();
    expect(await searchSkills("  release notes ", fetchImpl)).toEqual([
      { id: "acme/skills/release-notes", name: "release-notes", source: "acme/skills", installs: 1200 },
      { id: "acme/tools/lint", name: "lint", source: "acme/tools", installs: 3 },
    ]);
    expect(asked).toEqual(["https://skills.sh/api/search?q=release+notes"]);
    expect(await searchSkills("   ", fetchImpl)).toEqual([]);
    expect(asked).toHaveLength(1);
  });
});

describe("fetching a skill from GitHub", () => {
  it("takes the folder whose SKILL.md names it, at one commit, without hidden files", async () => {
    const { asked, fetchImpl } = fakeWeb();
    const skill = await fetchSkill("acme/skills", "release-notes", fetchImpl);
    expect(skill).toEqual({
      name: "release-notes",
      description: "Writes release notes.",
      files: { "SKILL.md": REPO["skills/notes/SKILL.md"], "template.md": "## Changes\n" },
    });
    expect(
      asked.filter((url) => url.includes("raw.githubusercontent.com")).every((url) => url.includes(`/${SHA}/`)),
    ).toBe(true);
    expect(asked.some((url) => url.endsWith(".env"))).toBe(false);
  });

  it("refuses a skill too large to share before fetching its files, and a source that is not owner/repo", async () => {
    const { asked, fetchImpl } = fakeWeb({ ...REPO, "skills/notes/big.md": "x".repeat(200_001) });
    await expect(fetchSkill("acme/skills", "release-notes", fetchImpl)).rejects.toThrow("larger than a shared skill");
    expect(asked.some((url) => url.endsWith("big.md"))).toBe(false);
    await expect(fetchSkill("acme/skills", "missing", fetchImpl)).rejects.toThrow("no skill named missing");
    for (const source of ["../etc", "acme/..", "acme/.", "acme/skills/extra", "-acme/skills"]) {
      await expect(fetchSkill(source, "x", fetchImpl)).rejects.toThrow("owner/repo");
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
    const route = installs(store, home, { deps: async () => deps, fetch: fakeWeb().fetchImpl });
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

describe("searching the MCP Registry", () => {
  const entry = (server: Record<string, unknown>) => ({ server: { version: "1.0.0", ...server }, _meta: {} });
  const registry = (servers: unknown[]) => {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      asked.push(String(input));
      return Response.json({ servers });
    }) as typeof fetch;
    return { asked, fetchImpl };
  };

  it("sends only the words, and keeps the servers it can share as they are, pinned, with the keys each person enters", async () => {
    const { asked, fetchImpl } = registry([
      entry({
        name: "app.linear/linear",
        title: "Linear",
        description: "Issues.",
        remotes: [
          {
            type: "streamable-http",
            url: "https://mcp.linear.app/mcp",
            headers: [{ name: "Authorization", value: "Bearer {api_key}", isSecret: true }],
          },
        ],
      }),
      entry({
        name: "io.github.acme/sentry",
        version: "2.1.0",
        packages: [
          {
            registryType: "npm",
            identifier: "@sentry/mcp",
            version: "2.1.0",
            transport: { type: "stdio" },
            environmentVariables: [
              { name: "SENTRY_TOKEN", isSecret: true },
              { name: "SENTRY_HOST", isRequired: true, default: "sentry.io" },
            ],
          },
        ],
      }),
      entry({
        name: "io.github.acme/files",
        packages: [
          {
            registryType: "npm",
            identifier: "files-mcp",
            version: "1.0.0",
            transport: { type: "stdio" },
            packageArguments: [{ type: "positional", isRequired: true, valueHint: "dir" }],
          },
        ],
      }),
      entry({
        name: "io.github.acme/postgres",
        packages: [
          {
            registryType: "oci",
            identifier: "ghcr.io/acme/postgres:0.1.3",
            transport: { type: "stdio" },
            runtimeArguments: [{ type: "named", name: "-v", value: "/:/host" }],
            environmentVariables: [{ name: "DATABASE_URL", isRequired: true, isSecret: true }],
          },
        ],
      }),
      entry({
        name: "io.github.acme/both",
        packages: [
          { registryType: "oci", identifier: "acme/both", version: "2.0.0", transport: { type: "stdio" } },
          { registryType: "npm", identifier: "both-mcp", version: "2.0.0", transport: { type: "stdio" } },
        ],
      }),
      entry({
        name: "io.github.acme/unpinned",
        packages: [{ registryType: "oci", identifier: "ghcr.io/acme/x:latest", transport: { type: "stdio" } }],
      }),
    ]);
    const found = await searchServers("  issues ", fetchImpl);
    expect(asked).toEqual([
      "https://registry.modelcontextprotocol.io/v0/servers?search=issues&version=latest&limit=30",
    ]);
    expect(found.map(({ name, config, credentials }) => ({ name, config, credentials }))).toEqual([
      {
        name: "app.linear/linear",
        config: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer {api_key}" } },
        credentials: ["api_key"],
      },
      {
        name: "io.github.acme/sentry",
        config: { command: "npx", args: ["-y", "@sentry/mcp@2.1.0"], env: { SENTRY_HOST: "sentry.io" } },
        credentials: ["SENTRY_TOKEN"],
      },
      {
        name: "io.github.acme/postgres",
        config: {
          command: "docker",
          args: ["run", "-i", "--rm", "-e", "DATABASE_URL", "ghcr.io/acme/postgres:0.1.3"],
        },
        credentials: ["DATABASE_URL"],
      },
      {
        name: "io.github.acme/both",
        config: { command: "npx", args: ["-y", "both-mcp@2.0.0"] },
        credentials: [],
      },
    ]);
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
    const route = installs(store, home, { deps: async () => deps });
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
      "SKILL.md": "---\nname: release-notes\ndescription: Writes notes.\n---\nRead the log.\n",
    });
  });

  it("adds a server by hand, refusing one that already holds a key", async () => {
    const route = installs(store, home, { deps: async () => deps });
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
