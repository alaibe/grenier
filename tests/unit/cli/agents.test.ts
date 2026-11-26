import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreDeps } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_CODE, CODEX, presentAgents, type Where } from "../../../apps/cli/src/agents/index.ts";
import { connectApp } from "../../../apps/cli/src/connect.ts";
import { install, share, uninstall } from "../../../apps/cli/src/installs.ts";
import { addServer, localServers } from "../../../apps/cli/src/servers.ts";
import { addLocalSkill, localSkills } from "../../../apps/cli/src/skills.ts";
import { storeDeps } from "../../support/repo.ts";

let store: Store;
let deps: StoreDeps;
let home: string;
let where: Where;

const codexConfig = () => parse(readFileSync(join(home, ".codex", "config.toml"), "utf8")) as Record<string, never>;
const claudeConfig = () => JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  deps = await storeDeps(store);
  home = mkdtempSync(join(tmpdir(), "grenier-agents-"));
  where = { home, platform: "linux", env: {}, self: ["/usr/bin/node", "grenier.js"] };
});

afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

const both = () => {
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
};

describe("Claude Code and Codex, each its own strategy", () => {
  it("counts the agents set up here, and Claude Code when none is", () => {
    expect(presentAgents(where)).toEqual([CLAUDE_CODE]);
    mkdirSync(join(home, ".codex"));
    expect(presentAgents(where)).toEqual([CODEX]);
    mkdirSync(join(home, ".claude"));
    expect(presentAgents(where)).toEqual([CLAUDE_CODE, CODEX]);
  });

  it("keeps Codex's servers in its TOML, a command with env or a URL with headers, and reads them back", () => {
    both();
    CODEX.editServers(where, (servers) => {
      servers.sentry = { type: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer s" } };
      servers.github = { command: "npx", args: ["-y", "github-mcp"], env: { GITHUB_TOKEN: "t" } };
    });
    expect(codexConfig().mcp_servers).toEqual({
      sentry: { url: "https://mcp.sentry.dev/mcp", http_headers: { Authorization: "Bearer s" } },
      github: { command: "npx", args: ["-y", "github-mcp"], env: { GITHUB_TOKEN: "t" } },
    });
    expect(CODEX.servers(where)).toEqual({
      sentry: { url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer s" } },
      github: { command: "npx", args: ["-y", "github-mcp"], env: { GITHUB_TOKEN: "t" } },
    });
  });

  it("gives each agent Grenier's prompt and the proxy its own way, in grenier run and in a routine's run", () => {
    expect(CLAUDE_CODE.runArgs(["-p", "hi"], "Call get.")).toEqual(["--append-system-prompt", "Call get.", "-p", "hi"]);
    expect(CODEX.runArgs(["exec"], null, "http://p")).toEqual(["-c", 'openai_base_url="http://p"', "exec"]);
    expect(CLAUDE_CODE.routine("Tidy.", "read-only").args).toContain("--tools");
    expect(CODEX.routine("Tidy.", "on", "http://p")).toEqual({
      command: "codex",
      args: ["exec", "--sandbox", "workspace-write", "-c", 'openai_base_url="http://p/openai/v1"', "Tidy."],
    });
  });

  it("installs a team skill and server into every agent here, and takes them off both", async () => {
    both();
    await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
    const skill = await share(deps, {
      type: "Skill",
      title: "notes",
      body: "",
      fields: { files: { "SKILL.md": "---\nname: notes\ndescription: Notes.\n---\nWrite.\n" } },
    });
    const server = await share(deps, {
      type: "McpServer",
      title: "linear",
      body: "",
      fields: { config: { type: "http", url: "https://mcp.linear.app/mcp" }, credentials: [] },
    });
    for (const { id } of [skill, server]) await install(store, where, (await store.records.get(id)) as FullRecord);
    expect(existsSync(join(home, ".claude", "skills", "grenier-notes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".codex", "skills", "grenier-notes", "SKILL.md"))).toBe(true);
    expect(claudeConfig().mcpServers["grenier-linear"]).toMatchObject({ url: "https://mcp.linear.app/mcp" });
    expect(codexConfig().mcp_servers).toMatchObject({ "grenier-linear": { url: "https://mcp.linear.app/mcp" } });
    expect(await localSkills(store, where)).toEqual([]);

    for (const { id } of [skill, server]) {
      await uninstall(store, where, (await store.records.get(id)) as FullRecord);
    }
    expect(existsSync(join(home, ".codex", "skills", "grenier-notes"))).toBe(false);
    expect(claudeConfig().mcpServers["grenier-linear"]).toBeUndefined();
    expect(codexConfig().mcp_servers).toBeUndefined();
  });

  it("writes the person's own skill and server for every agent here, and lists each agent's", async () => {
    both();
    addLocalSkill(where, { name: "notes", description: "", files: { "SKILL.md": "---\nname: notes\n---\nWrite.\n" } });
    expect((await localSkills(store, where)).map((skill) => [skill.id, skill.agent])).toEqual([
      ["claude:notes", "Claude Code"],
      ["codex:notes", "Codex"],
    ]);
    addServer(where, { name: "slack", entry: { type: "http", url: "https://slack.test/mcp" } });
    expect((await localServers(store, where)).map((server) => [server.client, server.name, server.editable])).toEqual([
      ["Claude Code", "slack", true],
      ["Codex", "slack", true],
    ]);
  });

  it("adds Grenier to Codex with its setup skill", async () => {
    both();
    await connectApp(store, "codex", ["*"], where);
    expect(codexConfig().mcp_servers).toMatchObject({ grenier: { args: ["grenier.js", "mcp", "serve"] } });
    expect(readFileSync(join(home, ".codex", "skills", "grenier-setup", "SKILL.md"), "utf8")).toContain(
      "name: grenier-setup",
    );
  });
});
