import { hasPrompt, type RoutineMode } from "@grenier/core";
import type { BuiltinView, LocalRun } from "@grenier/core/api";
import { Hono } from "hono";
import { BUILTINS } from "../builtins.ts";
import {
  addBuiltin,
  addRoutine,
  approve,
  editRoutine,
  routineApproval,
  routineFromForm,
  routineViews,
} from "../routines.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf, Missing, storeConflicts } from "./request.ts";

/** The team's routines on this machine: adding and changing them, approving one, and a run by hand. */
export function routineRoutes(deps: AdminDeps): Hono {
  const { store, runner } = deps;
  const app = storeConflicts(new Hono());

  const noTeam = { error: "routines run on the team's machines: start or join a team first" };
  const routine = async (id: string) => {
    const found = await store.records.get(id);
    if (found?.type !== "Routine" || found.retiredAt !== null) throw new Missing("no such routine");
    return found;
  };

  app.get("/routines", async (c) => c.json({ routines: await routineViews(store, deps.config().machine.agent) }));
  app.get("/runs", async (c) => c.json({ runs: (await store.runs.list({ limit: 50 })) satisfies LocalRun[] }));

  app.post("/routines", async (c) => {
    if (!deps.team()) return c.json(noTeam, 409);
    const form = routineFromForm(await bodyOf(c));
    return c.json(await addRoutine(await deps.storeDeps(), { ...form, top: "team" }));
  });

  app.get("/routines/builtins", (c) =>
    c.json({
      builtins: Object.entries(BUILTINS).map(([id, { admins: _admins, run, ...shown }]) => ({
        id,
        ...shown,
        local: Boolean(run),
      })) satisfies BuiltinView[],
    }),
  );

  /** One of the routines Grenier ships: the librarian, the answer refresher, the summaries, the keeper, the digest. */
  app.post("/routines/builtin/:id", async (c) => {
    if (!deps.team()) return c.json(noTeam, 409);
    return c.json(await addBuiltin(await deps.storeDeps(), c.req.param("id")));
  });

  app.put("/routines/:id", async (c) => {
    const found = await routine(c.req.param("id"));
    await editRoutine(await deps.storeDeps(), found, routineFromForm(await bodyOf(c)));
    return c.json({ id: found.id });
  });

  app.post("/routines/:id/approve", async (c) => {
    const found = await routine(c.req.param("id"));
    const input = await bodyOf(c);
    const limit = input.limit === undefined ? undefined : Number(input.limit);
    await approve(store, found, (input.mode as RoutineMode) ?? "read-only", limit);
    void runner.tick(true);
    return c.json({ approved: found.id });
  });

  /** This machine stops running it: its approval here goes, and the team keeps the routine. */
  app.delete("/routines/:id/approve", async (c) => {
    const found = await routine(c.req.param("id"));
    await store.approvals.remove(found.id, "routine");
    return c.json({ stopped: found.id });
  });

  app.post("/routines/:id/run", async (c) => {
    const found = await routine(c.req.param("id"));
    const approval = await routineApproval(store, found);
    if (!approval?.current) {
      return c.json({ error: "approve the routine as it is now before running it" }, 409);
    }
    if (!hasPrompt(found)) return c.json({ error: "the routine says nothing to do yet" }, 409);
    if (runner.running) return c.json({ error: "a run is going on this machine already" }, 409);
    const task = (await bodyOf(c)).task;
    const prompt = typeof task === "string" && task.trim() ? task.trim() : "Run now, as your prompt says.";
    runner.run({ routine: found, prompt, trigger: "manual", mode: approval.mode }).catch(() => undefined);
    return c.json({ started: true }, 202);
  });

  return app;
}
