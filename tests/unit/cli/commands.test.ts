import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../../apps/cli/src/cli.ts";
import { type Admin, answerOf } from "../../../apps/cli/src/commands/client.ts";
import { shownDiff } from "../../../apps/cli/src/commands/knowledge.ts";
import type { Io } from "../../../apps/cli/src/io.ts";
import { type TestAdmin, testAdmin } from "../../support/gateway.ts";

let store: Store;
let home: string;
let admin: TestAdmin;

beforeEach(() => {
  store = openSqliteStore(":memory:");
  home = mkdtempSync(join(tmpdir(), "grenier-commands-"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  admin = testAdmin(store, home);
});

afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

/** `grenier …` against the app's admin API, as the daemon serves it. */
async function grenier(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env: { GRENIER_HOME: join(home, ".grenier") },
    cwd: home,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    self: [],
  };
  const call: Admin = async (method, path, body) => {
    const { status, body: answer } = await admin.reply(method, path, body);
    return answerOf(status, answer);
  };
  const code = await run(argv, io, call);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const file = (name: string, text: string) => {
  const path = join(home, name);
  writeFileSync(path, text);
  return path;
};

describe("the CLI does what the app does", () => {
  it("has a command for every route of the admin API but the team store's, which go through /team", () => {
    const sources = readdirSync(join(import.meta.dirname, "../../../apps/cli/src/commands"))
      .map((name) => readFileSync(join(import.meta.dirname, "../../../apps/cli/src/commands", name), "utf8"))
      .join("\n");
    const called = new Set(
      [
        ...sources.matchAll(
          /admin(?:<[^(]*>)?\(\s*"(GET|POST|PUT|DELETE)",\s*(?:flags\.team \? "[^"]*" : )?[`"]([^`"?]*)/g,
        ),
      ].map((match) => `${match[1]} ${(match[2] as string).replace(/\$\{[^}]+\}/g, ":")}`),
    );
    for (const match of sources.matchAll(/flags\.team \? "([^"]*)" : "([^"]*)"/g)) {
      called.add(`POST ${match[1]}`);
      called.add(`POST ${match[2]}`);
    }
    const missing = admin.routes
      .filter((route) => route.method !== "ALL" && route.path !== "/health")
      .map((route) => `${route.method} ${route.path.replace(/:\w+(\{[^}]*\})?/g, ":")}`)
      .filter((route) => !called.has(route));
    expect(missing).toEqual([]);
  });

  it("lists its commands, and each group's", async () => {
    const top = await grenier("help");
    expect(top.out).toContain("page");
    expect(top.out).toContain("routine");
    const page = await grenier("page");
    expect(page.out).toContain("new <title>");
    expect((await grenier("page", "nope")).code).toBe(2);
    expect((await grenier("page", "show")).code).toBe(2);
  });

  it("writes, finds, changes, moves and deletes a page", async () => {
    const written = await grenier(
      "page",
      "new",
      "Release steps",
      "--folder",
      "Ops",
      "--body",
      file("b.md", "Tag, then push."),
    );
    expect(written.code).toBe(0);
    const id = /Saved (\S+)/.exec(written.out)?.[1] as string;
    expect((await grenier("page", "list", "--top", "me")).out).toContain("me / Ops / Release steps");
    expect((await grenier("page", "show", id)).out).toContain("Tag, then push.");
    expect((await grenier("page", "edit", id, "--body", file("c.md", "Tag, test, push."))).out).toContain("Saved");
    expect((await grenier("page", "history", id)).out).toContain("no versions yet");
    expect((await grenier("folder", "move", "me", "Ops", "Runbooks")).out).toBe("Moved 1 page");
    expect(JSON.parse((await grenier("page", "show", id, "--json")).out)).toMatchObject({
      folder: "Runbooks",
      body: "Tag, test, push.",
    });
    expect((await grenier("folder", "list")).out).toContain("me");
    expect((await grenier("page", "rm", id)).out).toBe("Deleted");
    expect((await grenier("page", "list")).out).not.toContain("Release steps");
  });

  it("writes a skill for every agent, edits and deletes one agent's copy", async () => {
    const instructions = file("i.md", "Read the log, then write.");
    const made = await grenier(
      "skill",
      "new",
      "release-notes",
      "--description",
      "Writes notes.",
      "--instructions",
      instructions,
    );
    expect(made.out).toBe("Wrote claude:release-notes");
    expect((await grenier("skill", "list")).out).toContain("codex:release-notes");
    expect((await grenier("skill", "show", "claude:release-notes")).out).toContain("Read the log, then write.");
    expect((await grenier("skill", "show", "release-notes")).err).toContain("several skills");
    const manifest = file("m.md", '---\nname: release-notes\ndescription: "Better."\n---\nWrite.\n');
    expect((await grenier("skill", "edit", "codex:release-notes", "--manifest", manifest)).out).toBe(
      "Saved codex:release-notes",
    );
    expect(readFileSync(join(home, ".codex", "skills", "release-notes", "SKILL.md"), "utf8")).toBe(
      readFileSync(manifest, "utf8"),
    );
    expect((await grenier("skill", "rm", "codex:release-notes")).out).toBe("Removed codex:release-notes");
    expect((await grenier("skill", "share", "release-notes")).err).toContain("no team");
  });

  it("adds a server to every agent, changes one copy and removes it", async () => {
    const added = await grenier(
      "server",
      "add",
      "docs",
      "--command",
      "npx",
      "--env",
      "TOKEN=t",
      "--",
      "-y",
      "docs-mcp",
    );
    expect(added.code).toBe(0);
    expect((await grenier("server", "list")).out).toMatch(/docs\s+Codex/);
    expect((await grenier("server", "show", "docs")).err).toContain("several servers");
    expect((await grenier("server", "show", "docs", "--app", "codex")).out).toContain("npx -y docs-mcp");
    expect((await grenier("server", "edit", "docs", "--app", "codex", "--env", "TOKEN=")).out).toContain(
      "restart Codex",
    );
    const codex = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(codex).not.toContain("TOKEN");
    expect((await grenier("server", "rm", "docs", "--app", "claude-code")).out).toBe("Removed docs from Claude Code");
    expect((await grenier("server", "add", "x")).code).toBe(2);
  });

  it("sets this machine's rules, adds Grenier to an app, makes and revokes a key, edits instructions", async () => {
    expect((await grenier("machine", "set", "routines=true", "idle_minutes=5")).out).toBe("Saved");
    expect((await grenier("machine", "show")).out).toMatch(/idle_minutes\s+5/);
    expect((await grenier("machine", "set", "nope=1")).err).toContain("has no nope");

    expect((await grenier("app", "add", "codex")).out).toContain("restart Codex");
    expect((await grenier("app", "list")).out).toMatch(/codex\s+Codex\s+added/);
    expect((await grenier("app", "key", "ci", "--scope", "me")).out).toContain("ci reads me with this key");
    expect((await grenier("app", "keys")).out).toContain("ci");
    expect((await grenier("app", "revoke", "ci")).out).toBe("Revoked ci's key");

    expect((await grenier("instructions", "list")).out).toContain("grenier/mcp");
    expect((await grenier("instructions", "edit", "grenier/mcp", "--text", file("t.md", "Call get."))).out).toBe(
      "Saved grenier/mcp",
    );
    expect((await grenier("instructions", "show", "grenier/mcp")).out).toBe("Call get.");
    expect((await grenier("instructions", "reset", "grenier/mcp")).code).toBe(0);
    expect((await grenier("instructions", "show", "grenier/mcp")).out).not.toBe("Call get.");
  });

  it("shows the status, Grenier's routines, the key, and refuses team commands without a team", async () => {
    expect((await grenier("status")).out).toMatch(/team\s+none/);
    expect((await grenier("routine", "builtins")).out).toContain("librarian");
    expect((await grenier("routine", "add", "librarian")).err).toContain("start or join a team");
    expect((await grenier("session", "list")).out).toBe("no paused sessions");
    expect((await grenier("key", "show")).out).toMatch(/\S{20,}/);
    expect((await grenier("team", "members")).err).toContain("in no team");
    expect((await grenier("team", "invite", "ana")).err).toContain("in no team");
  });

  it("shows a stale file's change line by line", () => {
    expect(shownDiff("a\nb\nc", "a\nB\nc")).toBe("  a\n+ B\n- b\n  c");
  });
});

describe("a SKILL.md's fields", () => {
  it("reads a description on one line, quoted, or folded under the key", async () => {
    const { skillField } = await import("../../../apps/cli/src/skill-files.ts");
    expect(skillField('---\nname: a\ndescription: "One: line."\n---\n', "description")).toBe("One: line.");
    expect(skillField("---\ndescription: >\n  Folded over\n  two lines.\nname: a\n---\n", "description")).toBe(
      "Folded over two lines.",
    );
    expect(skillField("---\ndescription: |\n  Kept\n  apart.\n---\n", "description")).toBe("Kept\napart.");
  });
});
