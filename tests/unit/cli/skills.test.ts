import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreDeps } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Where } from "../../../apps/cli/src/agents/index.ts";
import { install, share } from "../../../apps/cli/src/installs.ts";
import { manifestOf } from "../../../apps/cli/src/skill-files.ts";
import {
  addLocalSkill,
  localSkill,
  localSkills,
  removeLocalSkill,
  saveLocalSkill,
  skillFilesIn,
} from "../../../apps/cli/src/skills.ts";
import { storeDeps } from "../../support/repo.ts";

let store: Store;
let deps: StoreDeps;
let home: string;
let elsewhere: string;
let where: Where;

const manifest = (name: string, description = `Does ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`;

function skillAt(folder: string, name: string, extra: Record<string, string> = {}) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), manifest(name));
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
}

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  deps = await storeDeps(store);
  home = mkdtempSync(join(tmpdir(), "grenier-skills-"));
  elsewhere = mkdtempSync(join(tmpdir(), "grenier-skills-elsewhere-"));
  where = { home, platform: "linux", env: {}, self: [] };
});

afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

describe("the person's own skills", () => {
  it("lists their folders, links, synced and plugin skills, but not Grenier's installs of the team's", async () => {
    const skills = join(home, ".claude", "skills");
    skillAt(join(skills, "notes"), "notes", { "scripts/run.sh": "echo run\n" });
    skillAt(join(elsewhere, "omarchy"), "omarchy");
    symlinkSync(join(elsewhere, "omarchy"), join(skills, "omarchy"));
    mkdirSync(join(skills, "not-a-skill"));
    skillAt(join(skills, "synced", "bucket", "docx"), "docx");
    skillAt(join(elsewhere, "plugin", "skills", "review"), "review");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "reviewer@market": [{ installPath: join(elsewhere, "plugin") }] } }),
    );
    await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
    const { id } = await share(deps, {
      type: "Skill",
      title: "team-one",
      body: "",
      fields: { files: { "SKILL.md": manifest("team-one") } },
    });
    await install(store, where, (await store.records.get(id)) as FullRecord);

    expect((await localSkills(store, where)).map(({ id, kind, name }) => ({ id, kind, name }))).toEqual([
      { id: "claude:notes", kind: "own", name: "notes" },
      { id: "claude:omarchy", kind: "linked", name: "omarchy" },
      { id: "claude:synced/bucket/docx", kind: "synced", name: "docx" },
      { id: "claude:plugin/reviewer/review", kind: "plugin", name: "review" },
    ]);
    expect(await localSkill(store, where, "claude:notes")).toMatchObject({
      description: "Does notes.",
      manifest: manifest("notes"),
      files: ["scripts/run.sh"],
    });
    expect(skillFilesIn(join(skills, "notes"))).toEqual({
      "SKILL.md": manifest("notes"),
      "scripts/run.sh": "echo run\n",
    });
  });

  it("adds one, never over another, and saves only their own folders", async () => {
    const written = manifestOf({ name: "release-notes", description: "Writes notes: from tags.", instructions: "Go." });
    expect(written).toBe('---\nname: release-notes\ndescription: "Writes notes: from tags."\n---\nGo.\n');
    expect(addLocalSkill(where, { name: "release-notes", description: "", files: { "SKILL.md": written } })).toBe(
      "claude:release-notes",
    );
    expect(() =>
      addLocalSkill(where, { name: "release-notes", description: "", files: { "SKILL.md": written } }),
    ).toThrow("already");
    expect(() => manifestOf({ name: "Bad Name", description: "x", instructions: "y" })).toThrow("lowercase");

    await saveLocalSkill(store, where, "claude:release-notes", manifest("release-notes", "Better."));
    expect((await localSkill(store, where, "claude:release-notes")).description).toBe("Better.");

    skillAt(join(elsewhere, "linked"), "linked");
    symlinkSync(join(elsewhere, "linked"), join(home, ".claude", "skills", "linked"));
    await expect(saveLocalSkill(store, where, "claude:linked", manifest("linked", "No."))).rejects.toThrow(
      "change it there",
    );
    expect(readFileSync(join(elsewhere, "linked", "SKILL.md"), "utf8")).toBe(manifest("linked"));
  });

  it("removes a link without what it points to, and leaves synced skills to claude.ai", async () => {
    const skills = join(home, ".claude", "skills");
    skillAt(join(skills, "mine"), "mine");
    skillAt(join(elsewhere, "linked"), "linked");
    symlinkSync(join(elsewhere, "linked"), join(skills, "linked"));
    skillAt(join(skills, "synced", "bucket", "docx"), "docx");

    await removeLocalSkill(store, where, "claude:linked");
    expect(existsSync(join(skills, "linked"))).toBe(false);
    expect(existsSync(join(elsewhere, "linked", "SKILL.md"))).toBe(true);
    await removeLocalSkill(store, where, "claude:mine");
    expect(existsSync(join(skills, "mine"))).toBe(false);
    await expect(removeLocalSkill(store, where, "claude:synced/bucket/docx")).rejects.toThrow("claude.ai");
    await expect(removeLocalSkill(store, where, "claude:gone")).rejects.toThrow("no skill claude:gone");
  });
});
