import { hasPrompt, type RoutineMode, routineHash } from "@grenier/core";
import type { BuiltinView, LocalRun } from "@grenier/core/api";
import { StoreUseError } from "@grenier/index";
import { Hono } from "hono";
import { BUILTINS } from "../builtins.ts";
import { addBuiltin, addRoutine, approve, editRoutine, routineFromForm, routineViews } from "../routines.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf } from "./body.ts";

/** The team's routines on this machine: adding and changing them, approving one, and a run by hand. */
export function routineRoutes(deps: AdminDeps): Hono {
  const { store, runner } = deps;
  const app = new Hono();

  // What the team store would refuse is a conflict here, as every other refusal of these routes.
  app.onError((error) => {
    if (error instanceof StoreUseError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  });

  const noTeam = { error: "routines run on the team's machines: start or join a team first" };
  const routine = async (id: string) => {
    const found = await store.records.get(id);
    return found?.type === "Routine" && found.retiredAt === null ? found : null;
  };

  app.get("/routines", async (c) => c.json({ routines: await routineViews(store) }));
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
    if (!found) return c.json({ error: "no such routine" }, 404);
    await editRoutine(await deps.storeDeps(), found, routineFromForm(await bodyOf(c)));
    return c.json({ id: found.id });
  });

  app.post("/routines/:id/approve", async (c) => {
    const found = await routine(c.req.param("id"));
    if (!found) return c.json({ error: "no such routine" }, 404);
    const input = await bodyOf(c);
    await approve(store, found, (input.mode as RoutineMode) ?? "read-only", Number(input.limit ?? 10));
    void runner.tick(true);
    return c.json({ approved: found.id });
  });

  /** This machine stops running it: its approval here goes, and the team keeps the routine. */
  app.delete("/routines/:id/approve", async (c) => {
    const found = await routine(c.req.param("id"));
    if (!found) return c.json({ error: "no such routine" }, 404);
    await store.approvals.remove(found.id, "routine");
    return c.json({ stopped: found.id });
  });

  app.post("/routines/:id/run", async (c) => {
    const found = await routine(c.req.param("id"));
    if (!found) return c.json({ error: "no such routine" }, 404);
    const approval = await store.approvals.get(found.id, "routine");
    if (!approval || approval.hash !== (await routineHash(found))) {
      return c.json({ error: "approve the routine as it is now before running it" }, 409);
    }
    if (!hasPrompt(found)) return c.json({ error: "the routine says nothing to do yet" }, 409);
    if (runner.running) return c.json({ error: "a run is going on this machine already" }, 409);
    const task = (await bodyOf(c)).task;
    const prompt = typeof task === "string" && task.trim() ? task.trim() : "Run now, as your prompt says.";
    const mode = (approval.settings.mode as RoutineMode) ?? "read-only";
    runner.run({ routine: found, prompt, trigger: "manual", mode }).catch(() => undefined);
    return c.json({ started: true }, 202);
  });

  return app;
}
