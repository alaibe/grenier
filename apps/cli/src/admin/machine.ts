import { type Config, ConfigError, open, seal, VaultError } from "@grenier/core";
import type { KeyState, MachineState, ShownKey } from "@grenier/core/api";
import { setRules } from "@grenier/core/node";
import { rekeyed, teamApi, unopenedCount } from "@grenier/index";
import { Hono } from "hono";
import { ensurePersonalKey, personalKey, savePersonalKey } from "../runtime.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf } from "./body.ts";

/** This machine: the rules for when it takes the team's routine runs, and the personal key for the Me folder. */
export function machineRoutes(deps: AdminDeps): Hono {
  const { store, paths, runner } = deps;
  const app = new Hono();

  app.get("/machine", async (c) =>
    c.json({ rules: deps.config().machine, running: runner.running, ...(await runner.state()) } satisfies MachineState),
  );

  app.put("/machine", async (c) => {
    const rules = ((await bodyOf(c)).rules ?? {}) as Record<string, unknown>;
    let config: Config;
    try {
      config = setRules(paths, rules);
    } catch (error) {
      if (error instanceof ConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
    deps.reloaded(config);
    const team = deps.team();
    if (typeof rules.name === "string" && team) {
      await teamApi(team, "/api/me/device", { method: "PUT", body: { name: rules.name } }).catch(() => undefined);
    }
    void runner.tick(true);
    return c.json({ rules: config.machine, ...(await runner.state()) });
  });

  // The key is shown only when asked for, and never written anywhere but its own file.
  app.get("/key", async (c) => c.json({ unopened: await unopenedCount(store) } satisfies KeyState));
  app.post("/key", (c) => c.json({ key: ensurePersonalKey(paths) } satisfies ShownKey));

  app.put("/key", async (c) => {
    const key = String((await bodyOf(c)).key ?? "").trim();
    try {
      await open(key, "check", await seal(key, "check", new Uint8Array([1])));
    } catch (error) {
      return c.json({ error: error instanceof VaultError ? error.message : "that is not a personal key" }, 400);
    }
    if (personalKey(paths) !== key) {
      await deps.sync(async () => {
        savePersonalKey(paths, key);
        await rekeyed(store);
      });
    }
    return c.json({ saved: true, unopened: await unopenedCount(store) });
  });

  return app;
}
