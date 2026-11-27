import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreDeps, TeamClient } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRoutine, editRoutine } from "../../../../apps/cli/src/routines.ts";
import type { Runner } from "../../../../apps/cli/src/runner.ts";
import { testAdmin } from "../../../support/gateway.ts";
import { storeDeps } from "../../../support/repo.ts";

let store: Store;
let deps: StoreDeps;

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  deps = await storeDeps(store);
  await store.state.set("team_member", "ada");
});

afterEach(async () => {
  await store.close();
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
    return testAdmin(store, home, { runner, storeDeps: async () => deps, team: () => team }).reply;
  }

  it("runs a routine by hand only as this machine's person approved it", async () => {
    const { id } = await addRoutine(deps, {
      title: "Tidy",
      prompt: "Tidy up.",
      fields: {},
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
      fields: {},
    });
    expect((await run())?.status).toBe(409);
    expect(runs).toHaveLength(1);
  });

  it("stops running a routine here once its approval is taken back", async () => {
    const { id } = await addRoutine(deps, { title: "Tidy", prompt: "Tidy up.", fields: {}, top: "team" });
    await route()("POST", `/routines/${id}/approve`, { mode: "read-only" });
    expect(await store.approvals.get(id, "routine")).toBeDefined();
    expect((await route()("DELETE", `/routines/${id}/approve`))?.body).toEqual({ stopped: id });
    expect(await store.approvals.get(id, "routine")).toBeUndefined();
    expect((await route()("POST", `/routines/${id}/run`, {}))?.status).toBe(409);
  });

  it("adds no routine and no built-in outside a team: routines run on the team's machines", async () => {
    team = null;
    const form = { title: "Tidy", prompt: "Tidy up." };
    for (const reply of [
      await route()("POST", "/routines", form),
      await route()("POST", "/routines/builtin/librarian", {}),
    ]) {
      expect(reply?.status).toBe(409);
      expect(reply?.body).toEqual({ error: expect.stringContaining("start or join a team first") });
    }
    expect(await store.records.list({ tops: ["team"], type: "Routine" })).toEqual([]);
    team = { url: "https://team.test", token: "gt_x" };
    expect((await route()("POST", "/routines", form))?.status).toBe(200);
  });
});
