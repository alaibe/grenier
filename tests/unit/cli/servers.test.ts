import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Where } from "../../../apps/cli/src/agents/index.ts";
import { readServers } from "../../../apps/cli/src/agents/toml.ts";
import { serverToShare } from "../../../apps/cli/src/server-config.ts";
import {
  addServer,
  changeServer,
  localServers,
  MASK,
  maskArgs,
  maskUrl,
  removeServer,
  shareable,
} from "../../../apps/cli/src/servers.ts";

let store: Store;
let home: string;
let where: Where;
const TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ012345";

const claude = () => JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
const id = (scope: string, at: string | null, name: string, client = "claude-code") =>
  JSON.stringify([client, scope, at, name]);

beforeEach(() => {
  store = openSqliteStore(":memory:");
  home = mkdtempSync(join(tmpdir(), "grenier-servers-"));
  where = { home, platform: "linux", env: {}, self: [] };
  const project = join(home, "checkout");
  mkdirSync(project);
  writeFileSync(
    join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { postgres: { command: "npx", args: ["pg-mcp"] } } }),
  );
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      theme: "dark",
      mcpServers: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "github-mcp", "--token", TOKEN],
          env: { GITHUB_ORG: "acme" },
        },
        sentry: { type: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer s3cr3t" } },
        grenier: { type: "stdio", command: "grenier", args: ["mcp", "serve"], env: { GRENIER_CLIENT_TOKEN: "gc_x" } },
        "grenier-linear": { type: "http", url: "https://mcp.linear.app/mcp" },
      },
      projects: { [project]: { mcpServers: { docs: { type: "http", url: "https://docs.test/mcp?apiKey=abc" } } } },
    }),
  );
  mkdirSync(join(home, ".cursor"));
  writeFileSync(
    join(home, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { figma: { url: "https://f.test" } } }),
  );
  mkdirSync(join(home, ".codex"));
  writeFileSync(
    join(home, ".codex", "config.toml"),
    'model = "o4"\n\n[mcp_servers.notion]\ncommand = "npx"\nargs = ["-y", "notion-mcp"]\nenv = { NOTION_TOKEN = "x" }\n',
  );
});

afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the person's MCP servers", () => {
  it("lists every app's, with keys' names only, and the team's installs left to the team", async () => {
    await store.approvals.put({
      recordId: "r",
      kind: "mcp",
      hash: "h",
      approvedAt: 1,
      settings: { name: "grenier-linear" },
      installedPath: join(home, ".claude.json"),
      previousHash: null,
    });
    const servers = await localServers(store, where);
    expect(servers.map((server) => [server.client, server.scope, server.where, server.name, server.editable])).toEqual([
      ["Claude Code", "user", null, "github", true],
      ["Claude Code", "user", null, "sentry", true],
      ["Claude Code", "user", null, "grenier", false],
      ["Cursor", "user", null, "figma", false],
      ["Codex", "user", null, "notion", true],
      ["Claude Code", "project", join(home, "checkout"), "docs", true],
      ["Claude Code", "repo", join(home, "checkout"), "postgres", false],
    ]);
    const named = (name: string) => servers.find((server) => server.name === name);
    const [github, sentry, grenier, docs] = ["github", "sentry", "grenier", "docs"].map(named);
    expect(github).toMatchObject({ args: ["-y", "github-mcp", "--token", MASK], env: ["GITHUB_ORG"] });
    expect(sentry).toMatchObject({ transport: "http", headers: ["Authorization"] });
    expect(grenier?.grenier).toBe(true);
    expect(docs?.url).toBe(`https://docs.test/mcp?apiKey=${MASK}`);
    expect(JSON.stringify(servers)).not.toMatch(/s3cr3t|gc_x|acme|abc|ghp_/);
  });

  it("masks what looks like a key in arguments and URLs", () => {
    expect(maskArgs(["--api-key=abc", "--auth", "xyz", "--port", "3000", TOKEN])).toEqual([
      `--api-key=${MASK}`,
      "--auth",
      MASK,
      "--port",
      "3000",
      MASK,
    ]);
    expect(maskUrl("https://user:pw@x.test/mcp?token=t&q=1")).toBe(`https://user:${MASK}@x.test/mcp?token=${MASK}&q=1`);
  });

  it("changes a server, keeping a masked key as it was, and sets or removes a variable", () => {
    changeServer(where, id("user", null, "github"), {
      args: ["-y", "github-mcp@2", "--token", MASK],
      env: { GITHUB_ORG: null, GITHUB_TOKEN: "new" },
    });
    expect(claude().mcpServers.github).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "github-mcp@2", "--token", TOKEN],
      env: { GITHUB_TOKEN: "new" },
    });
    expect(() => changeServer(where, id("user", null, "github"), { args: ["--token", `x${MASK}`] })).toThrow("in full");
    changeServer(where, id("project", join(home, "checkout"), "docs"), { url: `https://docs.test/mcp?apiKey=${MASK}` });
    expect(claude().projects[join(home, "checkout")].mcpServers.docs.url).toBe("https://docs.test/mcp?apiKey=abc");
    expect(claude().theme).toBe("dark");
    expect(() => changeServer(where, id("user", null, "grenier"), { command: "x" })).toThrow("Settings");
    expect(() => changeServer(where, id("repo", join(home, "checkout"), "postgres"), { command: "x" })).toThrow(
      "repository",
    );
  });

  it("adds one, never over another nor under Grenier's names, and removes it", () => {
    const added = addServer(where, { name: "slack", entry: { type: "http", url: "https://slack.test/mcp" } });
    expect(claude().mcpServers.slack).toEqual({ type: "http", url: "https://slack.test/mcp" });
    expect(() => addServer(where, { name: "slack", entry: {} })).toThrow("already");
    expect(() => addServer(where, { name: "grenier-x", entry: {} })).toThrow("Grenier's");
    addServer(where, { project: join(home, "checkout"), name: "local", entry: { command: "run" } });
    expect(claude().projects[join(home, "checkout")].mcpServers.local).toEqual({ type: "stdio", command: "run" });
    removeServer(where, added);
    expect(claude().mcpServers.slack).toBeUndefined();
  });

  it("shares a server as templates each teammate fills in, with none of the person's values", () => {
    const sentry = serverToShare(shareable(where, id("user", null, "sentry")));
    expect(sentry).toEqual({
      config: { type: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer {authorization}" } },
      credentials: ["authorization"],
    });
    expect(() => serverToShare(shareable(where, id("user", null, "github")))).toThrow("arguments carry a credential");
    changeServer(where, id("user", null, "github"), { args: ["-y", "github-mcp"] });
    expect(serverToShare(shareable(where, id("user", null, "github")))).toEqual({
      config: { command: "npx", args: ["-y", "github-mcp"] },
      credentials: ["GITHUB_ORG"],
    });
  });

  it("reads Codex's servers from its TOML, inline env or its own table", () => {
    expect(
      readServers('[mcp_servers.a]\ncommand = "x"\nargs = ["1"]\n\n[mcp_servers.a.env]\nKEY = "v"\n[other]\nz = 1\n'),
    ).toEqual({ a: { command: "x", args: ["1"], env: { KEY: "v" } } });
  });
});
