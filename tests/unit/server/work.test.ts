import { describe, expect, it } from "vitest";
import { ADA, call, join, json, mf, pull, push } from "./harness.ts";

describe("requests", () => {
  async function routineAndTask(token: string) {
    await push(token, {
      id: "routine",
      top: "team",
      type: "Routine",
      title: "Update dependencies",
      body: "Update",
      fields: { trigger: "request", repo: "app" },
    });
    await push(token, {
      id: "task",
      top: "team",
      type: "Task",
      title: "Bump hono",
      fields: { status: "to-do", routine: "routine" },
    });
  }
  const state = (token: string, room: number, repos = ["app"]) =>
    call("/api/machines/me", token, { method: "PUT", body: { state: "available", room, repos, agents: ["claude"] } });

  it("offers a request to the available machine with the most room that has its repo, and to one at a time", async () => {
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
      fields: { trigger: "schedule", schedule },
    });
    expect((await push(ADA, routine("mon 09:00"))).applied).toHaveLength(1);
    expect((await push(ADA, routine("hourly"), 1)).applied).toHaveLength(1);
  });

  it("offers a request in a top only to the machines of its members", async () => {
    const bob = await join("bob");
    await call("/api/tops", ADA, { body: { name: "leads", members: ["ada"] } });
    await routineAndTask(ADA);
    await push(ADA, { id: "task", top: "top:leads" }, 1);
    await state(ADA, 0.3);
    await state(bob, 0.8);
    expect((await json<{ offer: unknown }>(await call("/api/work/claim", bob, { method: "POST" }))).offer).toBeNull();
    const offer = await json<{ offer: { task: { id: string } } }>(
      await call("/api/work/claim", ADA, { method: "POST" }),
    );
    expect(offer.offer.task.id).toBe("task");
  });

  it("goes to the next machine when one declines, and to none without its repo", async () => {
    const bob = await join("bob");
    await routineAndTask(ADA);
    await state(ADA, 0.3);
    await state(bob, 0.8, ["other"]);
    expect((await json<{ offer: unknown }>(await call("/api/work/claim", bob, { method: "POST" }))).offer).toBeNull();
    await state(bob, 0.8);
    await call("/api/work/claim", bob, { method: "POST" });
    await call("/api/work/task/decline", bob, { method: "POST" });
    const offer = await json<{ offer: { task: { id: string } } | null }>(
      await call("/api/work/claim", ADA, { method: "POST" }),
    );
    expect(offer.offer?.task.id).toBe("task");
  });

  it("offers a declined request to the same machine again once an admin changes its routine", async () => {
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

  it("offers a collector's request only to its person's machines", async () => {
    const bob = await join("bob", "bob-mbp", "admin");
    await push(bob, {
      id: "collector",
      top: "team",
      type: "Routine",
      title: "My meetings",
      body: "Gather",
      fields: { trigger: "request", collector: "yes" },
    });
    await push(ADA, {
      id: "gather",
      top: "team",
      type: "Task",
      title: "Gather today",
      fields: { status: "to-do", routine: "collector" },
    });
    await state(ADA, 0.9, []);
    await state(bob, 0.1, []);
    expect((await json<{ offer: unknown }>(await call("/api/work/claim", ADA, { method: "POST" }))).offer).toBeNull();
    const offer = await json<{ offer: { task: { id: string } } | null }>(
      await call("/api/work/claim", bob, { method: "POST" }),
    );
    expect(offer.offer?.task.id).toBe("gather");
  });

  it("turns a webhook call into a request for its routine", async () => {
    await routineAndTask(ADA);
    const { path } = await json<{ path: string }>(await call("/api/webhooks", ADA, { body: { routine: "routine" } }));
    const hooked = await mf.dispatchFetch(`https://team.test${path}`, {
      method: "POST",
      body: JSON.stringify({ title: "Bump zod" }),
    });
    expect(hooked.status).toBe(201);
    const titles = (await pull(ADA)).records.map((entry) => entry.title);
    expect(titles).toContain("Bump zod");
    expect((await mf.dispatchFetch(`https://team.test${path}x`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});
