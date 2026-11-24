import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@grenier/core";
import { resolvePaths } from "@grenier/core/node";
import type { StoreDeps, TeamClient } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addLibrarian,
  addRoutine,
  editRoutine,
  routineFromForm,
  routineRoutes,
} from "../../../apps/cli/src/routines.ts";
import type { Runner } from "../../../apps/cli/src/runner.ts";
import { storeDeps } from "../../support/repo.ts";

let store: Store;
let deps: StoreDeps;

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  deps = await storeDeps(store);
  await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
});

afterEach(async () => {
  await store.close();
});

describe("a routine written in the app", () => {
  it("takes what it does, when, its tools, its agent and its repository", () => {
    expect(
      routineFromForm({
        title: " Update dependencies ",
        prompt: "Bump them and run the tests.",
        trigger: "schedule",
        schedule: "daily 06:30",
        tools: "Edit, Bash(pnpm test:*)",
        agent: "codex",
        repo: "abc",
      }),
    ).toEqual({
      title: "Update dependencies",
      prompt: "Bump them and run the tests.",
      repo: "abc",
      fields: { trigger: "schedule", schedule: "daily 06:30", tools: ["Edit", "Bash(pnpm test:*)"], agent: "codex" },
    });
    expect(routineFromForm({ title: "Ask", prompt: "Answer.", collector: true })).toMatchObject({
      fields: { trigger: "request", collector: "yes" },
    });
    expect(() => routineFromForm({ title: "x", prompt: "y", trigger: "schedule", schedule: "at noon" })).toThrow(
      "daily 05:00",
    );
    expect(
      routineFromForm({ title: "x", prompt: "y", trigger: "schedule", schedule: "weekdays 18:00" }).fields,
    ).toEqual({
      trigger: "schedule",
      schedule: "weekdays 18:00",
    });
    expect(() => routineFromForm({ title: "", prompt: "y" })).toThrow("a name and what it does");
  });

  it("keeps one text per routine, changed in place, and adds the librarian once", async () => {
    const form = routineFromForm({ title: "Tidy", prompt: "Tidy up.", tools: "Edit" });
    const first = await addRoutine(deps, { ...form, top: "team" });
    expect(await store.records.get(first.id)).toMatchObject({ body: "Tidy up.", fields: { tools: ["Edit"] } });
    await expect(addRoutine(deps, { ...form, top: "team" })).rejects.toThrow("edit it");
    const old = { ...(await store.records.get(first.id)), fields: { tools: ["Edit"], versions: [], evals: [] } };
    await store.records.put(old as Parameters<typeof store.records.put>[0]);
    await editRoutine(
      deps,
      (await store.records.get(first.id)) as NonNullable<Awaited<ReturnType<typeof store.records.get>>>,
      routineFromForm({ title: "Tidy up", prompt: "Tidy up, then test.", trigger: "schedule", schedule: "hourly" }),
    );
    const edited = await store.records.get(first.id);
    expect(edited).toMatchObject({ title: "Tidy up", body: "Tidy up, then test." });
    expect(edited?.fields).toEqual({ trigger: "schedule", schedule: "hourly" });
    const librarian = await addLibrarian(deps);
    expect(librarian.added).toBe(true);
    expect(await addLibrarian(deps)).toEqual({ id: librarian.id, added: false });
  });

  it("refuses at once a text the team store would refuse, instead of keeping it here only", async () => {
    const long = routineFromForm({ title: "Long", prompt: "x".repeat(20_001) });
    await expect(addRoutine(deps, { ...long, top: "team" })).rejects.toThrow("the record is refused");
    const { id } = await addRoutine(deps, { ...routineFromForm({ title: "Ship", prompt: "Ship it." }), top: "team" });
    const leaky = routineFromForm({ title: "Ship", prompt: "Ship it with AKIAABCDEFGHIJKLMNOP." });
    await expect(editRoutine(deps, (await store.records.get(id)) as FullRecord, leaky)).rejects.toThrow(
      "looks like a key",
    );
    expect((await store.records.get(id))?.body).toBe("Ship it.");
    expect(await store.records.list({ tops: ["team"], type: "Routine" })).toHaveLength(1);
  });
});

describe("the routines' admin routes", () => {
  let home: string;
  let team: TeamClient | null;
  let runs: { routine: FullRecord; mode: string }[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "grenier-routines-"));
    team = { url: "https://team.test", token: "gt_x" };
    runs = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function route() {
    const runner = {
      running: false,
      tick: async () => {},
      run: async (input: { routine: FullRecord; mode: string }) => {
        runs.push(input);
      },
    } as unknown as Runner;
    return routineRoutes({
      store,
      paths: resolvePaths({ GRENIER_HOME: home }),
      runner,
      storeDeps: async () => deps,
      team: () => team,
      reloaded: () => {},
      config: defaultConfig,
    });
  }

  it("runs a routine by hand only as this machine's person approved it", async () => {
    const { id } = await addRoutine(deps, {
      title: "Tidy",
      prompt: "Tidy up.",
      fields: { trigger: "request" },
      repo: null,
      top: "team",
    });
    const run = () => route()("POST", `/routines/${id}/run`, {});
    expect(await run()).toEqual({ status: 409, body: { error: "approve the routine as it is now before running it" } });
    expect(runs).toEqual([]);
    expect((await route()("POST", `/routines/${id}/approve`, { mode: "shadow" }))?.status).toBe(200);
    expect((await run())?.status).toBe(202);
    expect(runs[0]?.mode).toBe("shadow");
    await editRoutine(deps, (await store.records.get(id)) as FullRecord, {
      title: "Tidy",
      prompt: "Tidy up, and delete what is old.",
      fields: { trigger: "request" },
      repo: null,
    });
    expect((await run())?.status).toBe(409);
    expect(runs).toHaveLength(1);
  });

  it("adds no routine and no librarian outside a team: routines run on the team's machines", async () => {
    team = null;
    const form = { title: "Tidy", prompt: "Tidy up." };
    for (const reply of [await route()("POST", "/routines", form), await route()("POST", "/routines/librarian", {})]) {
      expect(reply?.status).toBe(409);
      expect(reply?.body).toEqual({ error: expect.stringContaining("start or join a team first") });
    }
    expect(await store.records.list({ tops: ["team"], type: "Routine" })).toEqual([]);
    team = { url: "https://team.test", token: "gt_x" };
    expect((await route()("POST", "/routines", form))?.status).toBe(200);
  });
});
