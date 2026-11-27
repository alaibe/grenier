import { hasPrompt, isRunning } from "@grenier/core";
import type { LocalRun } from "@grenier/core/api";
import { Hono, type MiddlewareHandler } from "hono";
import { addRoutine, editRoutine, NO_TEAM, routineFromForm, routineViews, setRunning } from "../routines.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf, Missing, storeConflicts } from "./request.ts";

/** The team's routines: an admin adds, changes, pauses and resumes them, and any machine runs one by hand. */
export function routineRoutes(deps: AdminDeps): Hono {
  const { store, runner } = deps;
  const app = storeConflicts(new Hono());

  const routine = async (id: string) => {
    const found = await store.records.get(id);
    if (found?.type !== "Routine" || found.top !== "team" || found.retiredAt !== null) {
      throw new Missing("no such routine");
    }
    return found;
  };

  const inTeam: MiddlewareHandler = async (c, next) => (deps.team() ? next() : c.json({ error: NO_TEAM }, 409));
  for (const path of ["/routines", "/routines/*", "/runs"]) app.use(path, inTeam);

  app.get("/routines", async (c) => c.json({ routines: await routineViews(store, deps.config().machine.agent) }));
  app.get("/runs", async (c) => c.json({ runs: (await store.runs.list({ limit: 50 })) satisfies LocalRun[] }));

  app.post("/routines", async (c) =>
    c.json(await addRoutine(await deps.storeDeps(), routineFromForm(await bodyOf(c)))),
  );

  app.put("/routines/:id", async (c) => {
    const found = await routine(c.req.param("id"));
    await editRoutine(await deps.storeDeps(), found, routineFromForm(await bodyOf(c)));
    return c.json({ id: found.id });
  });

  app.post("/routines/:id/pause", async (c) => {
    const found = await routine(c.req.param("id"));
    await setRunning(await deps.storeDeps(), found, false);
    return c.json({ paused: found.id });
  });

  app.post("/routines/:id/resume", async (c) => {
    const found = await routine(c.req.param("id"));
    await setRunning(await deps.storeDeps(), found, true);
    void runner.tick(true);
    return c.json({ resumed: found.id });
  });

  app.post("/routines/:id/run", async (c) => {
    const found = await routine(c.req.param("id"));
    if (!isRunning(found)) return c.json({ error: "the routine is paused: an admin resumes it first" }, 409);
    if (!hasPrompt(found)) return c.json({ error: "the routine says nothing to do yet" }, 409);
    if (runner.running) return c.json({ error: "a run is going on this machine already" }, 409);
    const task = (await bodyOf(c)).task;
    const prompt = typeof task === "string" && task.trim() ? task.trim() : "Run now, as your prompt says.";
    runner.run({ routine: found, prompt, trigger: "manual" }).catch(() => undefined);
    return c.json({ started: true }, 202);
  });

  return app;
}
