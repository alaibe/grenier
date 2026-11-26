import type { LocalServer, ServerChange, SharedNow } from "@grenier/core/api";
import { StoreUseError } from "@grenier/index";
import { Hono } from "hono";
import { serverEntry, serverToShare, share } from "../installs.ts";
import { addServer, changeServer, claudeProjects, entryOf, localServers, removeServer, shareable } from "../servers.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf } from "./body.ts";

/** The person's own MCP servers: listed from every app, changed in Claude Code's and Codex's configs, shared by an admin. */
export function serverRoutes(deps: AdminDeps): Hono {
  const { store, where } = deps;
  const app = new Hono();
  // What the team store would refuse is a conflict here, as in the team's servers.
  app.onError((error) => {
    if (error instanceof StoreUseError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  });
  const id = (query: string | undefined) => String(query ?? "");

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
    const keys = Object.fromEntries(
      Object.entries((input.keys ?? {}) as Record<string, unknown>).map(([name, value]) => [name, String(value)]),
    );
    const entry = serverEntry({ fields: serverToShare(input) }, keys);
    return c.json({ id: addServer(where, { name: String(input.name ?? ""), entry }) }, 201);
  });

  app.put("/servers/one", async (c) => {
    changeServer(where, id(c.req.query("id")), (await bodyOf(c)) as ServerChange);
    return c.json({ saved: true });
  });

  app.delete("/servers/one", (c) => {
    removeServer(where, id(c.req.query("id")));
    return c.json({ removed: true });
  });

  /** An admin shares one of their servers: its values stay here, each becomes a key each teammate types. */
  app.post("/servers/share", async (c) => {
    const server = (await localServers(store, where)).find((entry) => entry.id === id(c.req.query("id")));
    const fields = serverToShare(shareable(where, id(c.req.query("id"))));
    const title = server?.name ?? "";
    const shared = await share(await deps.storeDeps(), { type: "McpServer", title, body: "", fields });
    return c.json({ ...shared, title } satisfies SharedNow);
  });

  return app;
}
