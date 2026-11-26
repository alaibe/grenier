import type { LocalServer, ServerChange } from "@grenier/core/api";
import { Hono } from "hono";
import { shareServer } from "../installs.ts";
import { entryOf, serverEntry, serverToShare, stringRecord } from "../server-config.ts";
import { addServer, changeServer, claudeProjects, localServers, removeServer, shareable } from "../servers.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf, queryId, storeConflicts } from "./request.ts";

/** The person's own MCP servers: listed from every app, changed in Claude Code's and Codex's configs, shared by an admin. */
export function serverRoutes(deps: AdminDeps): Hono {
  const { store, where } = deps;
  const app = storeConflicts(new Hono());

  app.get("/servers", async (c) => c.json({ servers: (await localServers(store, where)) satisfies LocalServer[] }));

  app.get("/servers/projects", (c) => c.json({ projects: claudeProjects(where) }));

  /** A server written in the app, with the values the person typed, which go only into the agents' configs. */
  app.post("/servers", async (c) => {
    const input = await bodyOf(c);
    const project = typeof input.project === "string" && input.project ? input.project : null;
    return c.json({ id: addServer(where, { project, name: String(input.name ?? ""), entry: entryOf(input) }) }, 201);
  });

  /** A server from the MCP Registry, filled in with the keys the person typed. */
  app.post("/servers/registry", async (c) => {
    const input = await bodyOf(c);
    const entry = serverEntry({ fields: serverToShare(input) }, stringRecord(input.keys));
    return c.json({ id: addServer(where, { name: String(input.name ?? ""), entry }) }, 201);
  });

  app.put("/servers/one", async (c) => {
    changeServer(where, queryId(c), (await bodyOf(c)) as ServerChange);
    return c.json({ saved: true });
  });

  app.delete("/servers/one", (c) => {
    removeServer(where, queryId(c));
    return c.json({ removed: true });
  });

  /** An admin shares one of their servers: its values stay here, each becomes a key each teammate types. */
  app.post("/servers/share", async (c) => {
    const { name, ...server } = shareable(where, queryId(c));
    return c.json(await shareServer(await deps.storeDeps(), name, "", serverToShare(server)));
  });

  return app;
}
