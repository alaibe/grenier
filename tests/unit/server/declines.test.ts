import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SETUP_TOKEN, startWorker } from "../../support/worker.ts";

const MINUTE = 60 * 1000;

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

it("offers a declined request to the same machine again once its decline is 30 minutes old", async () => {
  expect((await call("/api/setup", { body: { member: "ada", device: "ada-mbp" } })).status).toBe(201);
  const change = (id: string, record: Record<string, unknown>) => ({
    id: `change-${id}`,
    recordId: id,
    baseVersion: 0,
    changed: Object.keys(record),
    record: { id, ...record },
  });
  const pushed = await call("/api/changes", {
    body: {
      changes: [
        change("routine", {
          top: "team",
          type: "Routine",
          title: "Update",
          body: "Update",
          fields: { trigger: "request" },
        }),
        change("task", {
          top: "team",
          type: "Task",
          title: "Bump hono",
          fields: { status: "to-do", routine: "routine" },
        }),
      ],
    },
  });
  expect((await pushed.json()) as { applied: unknown[] }).toMatchObject({ applied: [{}, {}] });
  const claim = async (ahead: number) => {
    await call("/api/machines/me", { method: "PUT", body: { state: "available", room: 1, agents: ["claude"] }, ahead });
    const { offer } = (await (await call("/api/work/claim", { ahead })).json()) as { offer: { task: { id: string } } };
    return offer?.task.id ?? null;
  };

  expect(await claim(0)).toBe("task");
  await call("/api/work/task/decline");
  expect(await claim(0)).toBeNull();
  expect(await claim(29 * MINUTE)).toBeNull();
  expect(await claim(31 * MINUTE)).toBe("task");
});
