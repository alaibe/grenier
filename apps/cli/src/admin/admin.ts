import { type Config, ConfigError } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { type StoreDeps, StoreUseError, type SyncResult, type TeamClient, TeamError } from "@grenier/index";
import type { Prices } from "@grenier/log";
import type { Store } from "@grenier/store";
import { Hono } from "hono";
import type { Where } from "../agents/index.ts";
import { Refusal } from "../io.ts";
import type { Runner } from "../runner.ts";
import { appRoutes } from "./apps.ts";
import { installRoutes } from "./installs.ts";
import { instructionRoutes } from "./instructions.ts";
import { machineRoutes } from "./machine.ts";
import { overviewRoutes } from "./overview.ts";
import { recordRoutes } from "./records.ts";
import { Missing } from "./request.ts";
import { routineRoutes } from "./routines.ts";
import { serverRoutes } from "./servers.ts";
import { skillRoutes } from "./skills.ts";
import { teamRoutes } from "./team.ts";

export interface AdminDeps {
  store: Store;
  prices: Prices;
  paths: GrenierPaths;
  /** The config as it is now: Settings changes this machine's rules in it while the daemon runs. */
  config: () => Config;
  /** Called after the rules changed, so the daemon reads them again. */
  reloaded: (config: Config) => void;
  token: string;
  version: string;
  /** Who the daemon is, so a client can tell it from another program that reused its pid. */
  identity?: { pid: number; port: number };
  storeDeps: () => Promise<StoreDeps>;
  team: () => TeamClient | null;
  /** A round of sync now, `between` first while no round runs; null when it failed, or with no team. */
  sync: (between?: () => Promise<void>) => Promise<SyncResult | null>;
  /** Called once this machine joined or deployed a team: the daemon starts its link to the team store. */
  joined: (team: TeamClient) => void;
  runner: Runner;
  where: Where;
  /** Reaches the team store, Cloudflare, skills.sh, GitHub and the MCP Registry; tests pass a stand-in. */
  fetch?: typeof fetch;
  /** The built Worker a deploy uploads, dist/server beside the CLI's bundle; tests pass their own. */
  serverDir?: string;
}

/** The desktop app's webview: Tauri serves it from these origins; the Vite dev server from the last. */
const APP_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1440",
]);

function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/** The desktop app's API, served under /admin with the admin token: one sub-app per resource. */
export function createAdmin(deps: AdminDeps): Hono {
  const app = new Hono();

  app.use(async (c, next) => {
    const origin = c.req.header("origin");
    const allowed = origin && APP_ORIGINS.has(origin) ? origin : null;
    if (c.req.method === "OPTIONS") {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": allowed,
          "access-control-allow-methods": "GET, POST, PUT, DELETE",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "600",
        },
      });
    }
    if (c.req.header("authorization") !== `Bearer ${deps.token}`) {
      // The app's own origin gets the header even here, so it can read the 401 instead of seeing no answer.
      const refused = problem(401, "the admin API needs the token in ~/.grenier/admin-token");
      if (allowed) refused.headers.set("access-control-allow-origin", allowed);
      return refused;
    }
    await next();
    if (allowed) c.res.headers.set("access-control-allow-origin", allowed);
    return undefined;
  });

  // Any other error is a bug: it goes on to a 500, never reported as a refusal.
  app.onError((error) => {
    if (error instanceof StoreUseError || error instanceof ConfigError) return problem(400, error.message);
    if (error instanceof Missing) return problem(404, error.message);
    if (error instanceof Refusal) return problem(409, error.message);
    // The app reads a 401 as its own admin token refused: the team store's means this machine was removed.
    if (error instanceof TeamError && error.status === 401) {
      return problem(409, "the team store no longer knows this machine: it was removed from the team");
    }
    if (error instanceof TeamError) return problem(error.status >= 500 ? 502 : error.status, error.detail);
    throw error;
  });

  app.get("/health", (c) => c.json({ ...deps.identity, version: deps.version }));
  for (const routes of [
    overviewRoutes,
    recordRoutes,
    teamRoutes,
    installRoutes,
    skillRoutes,
    serverRoutes,
    instructionRoutes,
    routineRoutes,
    machineRoutes,
    appRoutes,
  ]) {
    app.route("/", routes(deps));
  }
  // Registered last: within /admin, nothing falls through to the proxy.
  app.all("*", (c) => problem(404, `no ${c.req.method} ${c.req.path.replace(/^\/admin/, "")}`));

  return app;
}
