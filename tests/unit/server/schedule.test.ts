import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SETUP_TOKEN, startWorker } from "../../support/worker.ts";

const HOUR = 60 * 60 * 1000;

let mf: Miniflare;
let worker: Awaited<ReturnType<typeof startWorker>>["call"];

beforeEach(async () => {
  ({ mf, call: worker } = await startWorker({ clock: true }));
}, 60_000);

afterEach(async () => {
  await mf.dispose();
});

const call = (path: string, init: { method?: string; body?: unknown; ahead?: number } = {}) =>
  worker(path, SETUP_TOKEN, { ...init, method: init.method ?? "POST", ahead: init.ahead ?? 0 });

const routine = (id: string, state: string) => ({
  id: `change-${id}-${state}`,
  recordId: id,
  baseVersion: 0,
  changed: ["top", "type", "title", "body", "fields"],
  record: {
    id,
    top: "team",
    type: "Routine",
    title: id,
    body: "Update, then run the tests.",
    fields: { schedule: "hourly", mode: "read-only", state },
  },
});

/** The routines whose task the store filed itself, once their schedule fell due. */
async function filed(ahead: number): Promise<string[]> {
  // The request sets the store's clock ahead; the alarm then runs at that time.
  await call("/api/me", { method: "GET", ahead });
  const store = await mf.getDurableObjectNamespace("TEAM");
  await (store.get(store.idFromName("team")) as unknown as { ring: () => Promise<void> }).ring();
  const { records } = (await (await call("/api/changes?after=0&limit=500", { method: "GET", ahead })).json()) as {
    records: { type: string; author: string; fields: { routine?: string } }[];
  };
  return records
    .filter((record) => record.type === "Task" && record.author === "schedule")
    .map((record) => String(record.fields.routine))
    .sort();
}

it("schedules only running routines: a paused one's time passes without a task", async () => {
  expect((await call("/api/setup", { body: { member: "ada", device: "ada-mbp" } })).status).toBe(201);
  const pushed = await call("/api/changes", {
    body: { changes: [routine("on", "running"), routine("off", "paused")] },
  });
  expect(((await pushed.json()) as { applied: unknown[] }).applied).toHaveLength(2);
  expect(await filed(2 * HOUR)).toEqual(["on"]);
});
