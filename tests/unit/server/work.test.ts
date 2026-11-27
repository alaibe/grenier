import { describe, expect, it } from "vitest";
import { ADA, call, join, json, push } from "./harness.ts";

describe("routines' tasks", () => {
  async function routineAndTask(token: string) {
    await push(token, {
      id: "routine",
      top: "team",
      type: "Routine",
      title: "Update dependencies",
      body: "Update",
      fields: { mode: "read-only", state: "running" },
    });
    await push(token, {
      id: "task",
      top: "team",
      type: "Task",
      title: "Bump hono",
      fields: { status: "to-do", routine: "routine" },
    });
  }
  const state = (token: string, room: number, agents = ["claude"]) =>
    call("/api/machines/me", token, { method: "PUT", body: { state: "available", room, agents } });

  it("offers a task to the available machine with the most room, and to one at a time", async () => {
    const bob = await join("bob");
    await routineAndTask(ADA);
    await state(ADA, 0.3);
    await state(bob, 0.8);
    expect((await json<{ offer: unknown }>(await call("/api/work/claim", ADA, { method: "POST" }))).offer).toBeNull();
    const offer = await json<{ offer: { task: { id: string } } }>(
      await call("/api/work/claim", bob, { method: "POST" }),
    );
    expect(offer.offer.task.id).toBe("task");
    expect((await json<{ offer: unknown }>(await call("/api/work/claim", bob, { method: "POST" }))).offer).toBeNull();
  });

  it("takes a routine's schedule, and a change to it", async () => {
    const routine = (schedule: string) => ({
      id: "nightly",
      top: "team",
      type: "Routine",
      title: "Nightly digest",
      body: "Digest",
      fields: { schedule, mode: "read-only", state: "running" },
    });
    expect((await push(ADA, routine("mon 09:00"))).applied).toHaveLength(1);
    expect((await push(ADA, routine("hourly"), 1)).applied).toHaveLength(1);
  });

  it("goes to the next machine when one declines, and to none without its agent", async () => {
    const bob = await join("bob");
    await routineAndTask(ADA);
    await state(ADA, 0.3);
    await state(bob, 0.8, ["codex"]);
    expect((await json<{ offer: unknown }>(await call("/api/work/claim", bob, { method: "POST" }))).offer).toBeNull();
    await state(bob, 0.8);
    await call("/api/work/claim", bob, { method: "POST" });
    await call("/api/work/task/decline", bob, { method: "POST" });
    const offer = await json<{ offer: { task: { id: string } } | null }>(
      await call("/api/work/claim", ADA, { method: "POST" }),
    );
    expect(offer.offer?.task.id).toBe("task");
  });

  it("offers a declined task to the same machine again once an admin changes its routine", async () => {
    await routineAndTask(ADA);
    await state(ADA, 0.5);
    const claim = async () =>
      (await json<{ offer: { task: { id: string } } | null }>(await call("/api/work/claim", ADA, { method: "POST" })))
        .offer;
    expect((await claim())?.task.id).toBe("task");
    await call("/api/work/task/decline", ADA, { method: "POST" });
    expect(await claim()).toBeNull();
    expect((await push(ADA, { id: "routine", body: "Update, then run the tests" }, 1)).applied).toHaveLength(1);
    expect((await claim())?.task.id).toBe("task");
  });

  it("offers no task of a paused routine, and takes a pause only from an admin", async () => {
    const bob = await join("bob");
    await routineAndTask(ADA);
    await state(ADA, 0.5);
    const paused = { id: "routine", fields: { mode: "read-only", state: "paused" } };
    const refused = await push(bob, paused, 1);
    expect(refused.refused[0]?.reason).toContain("only an admin writes in Team");
    expect((await push(ADA, paused, 1)).applied).toHaveLength(1);
    const claim = async () =>
      (await json<{ offer: { task: { id: string } } | null }>(await call("/api/work/claim", ADA, { method: "POST" })))
        .offer;
    expect(await claim()).toBeNull();
    expect(
      (await push(ADA, { id: "routine", fields: { mode: "read-only", state: "running" } }, 3)).applied,
    ).toHaveLength(1);
    expect((await claim())?.task.id).toBe("task");
  });
});
