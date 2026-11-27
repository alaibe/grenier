import type { StoreDeps } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRoutine, editRoutine, routineFromForm, setRunning } from "../../../apps/cli/src/routines.ts";
import { storeDeps } from "../../support/repo.ts";

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

describe("a routine written in the app", () => {
  it("takes what it does, when, its agent, and what a run may do", () => {
    expect(
      routineFromForm({
        title: " Update dependencies ",
        prompt: "Bump them and run the tests.",
        schedule: "daily 06:30",
        agent: "codex",
        mode: "limited",
        limit: "4",
      }),
    ).toEqual({
      title: "Update dependencies",
      prompt: "Bump them and run the tests.",
      fields: { schedule: "daily 06:30", agent: "codex", mode: "limited", limit: 4 },
    });
    expect(() => routineFromForm({ title: "x", prompt: "y", schedule: "at noon" })).toThrow("daily 05:00");
    expect(routineFromForm({ title: "x", prompt: "y", schedule: "weekdays 18:00" }).fields).toEqual({
      schedule: "weekdays 18:00",
      mode: "read-only",
    });
    expect(routineFromForm({ title: "x", prompt: "y", mode: "on", limit: 4 }).fields).toEqual({ mode: "on" });
    expect(() => routineFromForm({ title: "x", prompt: "y", mode: "wild" })).toThrow("a mode is one of");
    expect(() => routineFromForm({ title: "x", prompt: "y", mode: "limited", limit: 0 })).toThrow("1 or more");
    expect(() => routineFromForm({ title: "", prompt: "y" })).toThrow("a name and what it does");
  });

  it("keeps Claude Code when the admin chose it, so a Codex machine runs it with Claude Code", () => {
    expect(routineFromForm({ title: "x", prompt: "y", agent: "claude" }).fields).toEqual({
      agent: "claude",
      mode: "read-only",
    });
    expect(() => routineFromForm({ title: "x", prompt: "y", agent: "gemini" })).toThrow("an agent is claude or codex");
  });

  it("keeps one text per routine in Team, changed in place, running or paused as it was", async () => {
    const form = routineFromForm({ title: "Tidy", prompt: "Tidy up.", agent: "codex" });
    const first = await addRoutine(deps, form);
    expect(await store.records.get(first.id)).toMatchObject({
      top: "team",
      body: "Tidy up.",
      fields: { agent: "codex", mode: "read-only", state: "running" },
    });
    await expect(addRoutine(deps, form)).rejects.toThrow("edit it");
    await setRunning(deps, (await store.records.get(first.id)) as FullRecord, false);
    await editRoutine(
      deps,
      (await store.records.get(first.id)) as FullRecord,
      routineFromForm({ title: "Tidy up", prompt: "Tidy up, then test.", schedule: "hourly", mode: "shadow" }),
    );
    const edited = await store.records.get(first.id);
    expect(edited).toMatchObject({ title: "Tidy up", body: "Tidy up, then test." });
    expect(edited?.fields).toEqual({ schedule: "hourly", mode: "shadow", state: "paused" });
    await setRunning(deps, edited as FullRecord, true);
    expect((await store.records.get(first.id))?.fields.state).toBe("running");
  });

  it("lets only an admin pause a routine: a member's machine refuses at once", async () => {
    const { id } = await addRoutine(deps, routineFromForm({ title: "Ship", prompt: "Ship it." }));
    await store.state.set("team_role", "member");
    await expect(setRunning(deps, (await store.records.get(id)) as FullRecord, false)).rejects.toThrow(
      "only an admin writes in Team",
    );
    expect((await store.records.get(id))?.fields.state).toBe("running");
  });

  it("refuses at once a text the team store would refuse, instead of keeping it here only", async () => {
    const long = routineFromForm({ title: "Long", prompt: "x".repeat(20_001) });
    await expect(addRoutine(deps, long)).rejects.toThrow("the record is refused");
    const { id } = await addRoutine(deps, routineFromForm({ title: "Ship", prompt: "Ship it." }));
    const leaky = routineFromForm({ title: "Ship", prompt: "Ship it with AKIAABCDEFGHIJKLMNOP." });
    await expect(editRoutine(deps, (await store.records.get(id)) as FullRecord, leaky)).rejects.toThrow(
      "looks like a key",
    );
    expect((await store.records.get(id))?.body).toBe("Ship it.");
    expect(await store.records.list({ tops: ["team"], type: "Routine" })).toHaveLength(1);
  });
});
