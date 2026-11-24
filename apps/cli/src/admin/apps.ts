import type { AppView, ClientMade, Clients } from "@grenier/core/api";
import { addClient } from "@grenier/index";
import { Hono } from "hono";
import { APPS, type App, configPath, connectApp, connected, LABELS } from "../connect.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf } from "./body.ts";

/** The apps on this computer Grenier can be added to, and the keys apps read the store with over MCP. */
export function appRoutes(deps: AdminDeps): Hono {
  const { store, where } = deps;
  const app = new Hono();

  app.get("/apps", (c) =>
    c.json({
      apps: APPS.map((name) => ({
        app: name,
        label: LABELS[name],
        connected: connected(name, configPath(name, where.home, where.platform, where.env)),
      })) satisfies AppView[],
    }),
  );

  app.post("/apps/:app{[\\w-]+}", async (c) => {
    const name = c.req.param("app");
    if (!APPS.includes(name as App)) return c.json({ error: `Grenier cannot be added to ${name}` }, 404);
    const given = (await bodyOf(c)).scopes;
    const scopes = Array.isArray(given) ? given.map(String) : ["*"];
    const file = await connectApp(store, name as App, scopes, where);
    return c.json({ app: name, file, restart: LABELS[name as App] });
  });

  app.get("/clients", async (c) => {
    const tops = await store.tops.list();
    return c.json({
      clients: (await store.clients.list())
        .filter((client) => client.revokedAt === null)
        .map((client) => ({ name: client.name, scopes: client.scopes, createdAt: client.createdAt })),
      scopes: ["*", ...tops.map((top) => top.id)],
    } satisfies Clients);
  });

  app.post("/clients", async (c) => {
    const body = await bodyOf(c);
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    if (typeof body.name !== "string") return c.json({ error: "name is required" }, 400);
    const token = await addClient(store, body.name, scopes);
    return c.json({ name: body.name, scopes, token } satisfies ClientMade, 201);
  });

  app.post("/clients/:name/revoke", async (c) =>
    (await store.clients.revoke(c.req.param("name"), Date.now()))
      ? c.json({ revoked: c.req.param("name") })
      : c.json({ error: `no app named ${c.req.param("name")} reads Grenier` }, 404),
  );

  return app;
}
