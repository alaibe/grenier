import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreDeps, TeamClient } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRoutine, routineFromForm } from "../../../../apps/cli/src/routines.ts";
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
  let runs: { routine: FullRecord }[];

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
      run: async (input: { routine: FullRecord }) => {
        runs.push(input);
      },
    } as unknown as Runner;
    return testAdmin(store, home, { runner, storeDeps: async () => deps, team: () => team }).reply;
  }

  it("runs a running routine by hand, as its admin set it, and a paused one not at all", async () => {
    const { id } = await addRoutine(deps, routineFromForm({ title: "Tidy", prompt: "Tidy up.", mode: "shadow" }));
    const run = () => route()("POST", `/routines/${id}/run`, {});
    expect((await run())?.status).toBe(202);
    expect(runs[0]?.routine.fields.mode).toBe("shadow");
    expect((await route()("POST", `/routines/${id}/pause`, {}))?.body).toEqual({ paused: id });
    expect(await run()).toEqual({ status: 409, body: { error: "the routine is paused: an admin resumes it first" } });
    expect(runs).toHaveLength(1);
    const listed = (await route()("GET", "/routines"))?.body as { routines: { state: string; mode: string }[] };
    expect(listed.routines[0]).toMatchObject({ state: "paused", mode: "shadow", limit: 10 });
    expect((await route()("POST", `/routines/${id}/resume`, {}))?.body).toEqual({ resumed: id });
    expect((await run())?.status).toBe(202);
  });

  it("refuses a member's pause: only an admin sets a routine running or paused", async () => {
    const { id } = await addRoutine(deps, routineFromForm({ title: "Tidy", prompt: "Tidy up." }));
    await store.state.set("team_role", "member");
    const reply = await route()("POST", `/routines/${id}/pause`, {});
    expect(reply?.status).toBe(409);
    expect((await store.records.get(id))?.fields.state).toBe("running");
  });

  it("has no routines outside a team: every route says to start or join one", async () => {
    const { id } = await addRoutine(deps, routineFromForm({ title: "Tidy", prompt: "Tidy up." }));
    team = null;
    for (const [method, path] of [
      ["GET", "/routines"],
      ["GET", "/runs"],
      ["POST", "/routines"],
      ["PUT", `/routines/${id}`],
      ["POST", `/routines/${id}/pause`],
      ["POST", `/routines/${id}/resume`],
      ["POST", `/routines/${id}/run`],
    ] as const) {
      const reply = await route()(method, path, method === "GET" ? undefined : { title: "New", prompt: "Do it." });
      expect(reply?.status).toBe(409);
      expect(reply?.body).toEqual({ error: "routines run on the team's machines: start or join a team first" });
    }
    expect(runs).toEqual([]);
    expect(await store.records.list({ tops: ["team"], type: "Routine" })).toHaveLength(1);
  });
});
