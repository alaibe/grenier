import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testAdmin } from "../../../support/gateway.ts";
import { storeDeps } from "../../../support/repo.ts";

let store: Store;
let home: string;

beforeEach(() => {
  store = openSqliteStore(":memory:");
  home = mkdtempSync(join(tmpdir(), "grenier-skill-routes-"));
});

afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the person's skills from the app", () => {
  it("writes one, reads it, saves it, shares it only in a team, and deletes it", async () => {
    const deps = await storeDeps(store);
    const route = testAdmin(store, home, { storeDeps: async () => deps }).reply;
    const written = await route("POST", "/skills", {
      name: "release-notes",
      description: "Writes notes.",
      instructions: "Read the log.",
    });
    expect(written).toEqual({ status: 201, body: { id: "claude:release-notes" } });
    expect(existsSync(join(home, ".claude", "skills", "release-notes", "SKILL.md"))).toBe(true);
    expect((await route("GET", "/skills"))?.body).toMatchObject({
      skills: [{ id: "claude:release-notes", kind: "own", description: "Writes notes." }],
    });

    const manifest = '---\nname: release-notes\ndescription: "Better."\n---\nRead the log, then write.\n';
    expect((await route("PUT", "/skills/one?id=claude%3Arelease-notes", { manifest }))?.status).toBe(200);
    expect((await route("GET", "/skills/one?id=claude%3Arelease-notes"))?.body).toMatchObject({ manifest, files: [] });

    expect((await route("POST", "/skills/share?id=claude%3Arelease-notes"))?.body).toEqual({
      error: "this machine is in no team: join one first",
    });
    await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
    expect((await route("POST", "/skills/share?id=claude%3Arelease-notes"))?.body).toMatchObject({
      title: "release-notes",
      updated: false,
    });
    expect(await store.records.list({ tops: ["team"], type: "Skill" })).toHaveLength(1);

    expect((await route("DELETE", "/skills/one?id=claude%3Arelease-notes"))?.status).toBe(200);
    expect(existsSync(join(home, ".claude", "skills", "release-notes"))).toBe(false);
    expect((await route("GET", "/skills/one?id=claude%3Arelease-notes"))?.status).toBe(409);
  });
});
