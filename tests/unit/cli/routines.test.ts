import type { StoreDeps } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addLibrarian, addRoutine, editRoutine, routineFromForm } from "../../../apps/cli/src/routines.ts";
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
  it("takes what it does, when, and its agent", () => {
    expect(
      routineFromForm({
        title: " Update dependencies ",
        prompt: "Bump them and run the tests.",
        trigger: "schedule",
        schedule: "daily 06:30",
        agent: "codex",
      }),
    ).toEqual({
      title: "Update dependencies",
      prompt: "Bump them and run the tests.",
      fields: { trigger: "schedule", schedule: "daily 06:30", agent: "codex" },
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
    const form = routineFromForm({ title: "Tidy", prompt: "Tidy up.", agent: "codex" });
    const first = await addRoutine(deps, { ...form, top: "team" });
    expect(await store.records.get(first.id)).toMatchObject({ body: "Tidy up.", fields: { agent: "codex" } });
    await expect(addRoutine(deps, { ...form, top: "team" })).rejects.toThrow("edit it");
    const old = { ...(await store.records.get(first.id)), fields: { agent: "codex", versions: [], evals: [] } };
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
