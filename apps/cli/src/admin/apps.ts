import { TOPS } from "@grenier/core";
import type { AppView, ClientMade, Clients } from "@grenier/core/api";
import { addClient } from "@grenier/index";
import { Hono } from "hono";
import { z } from "zod";
import { CLIENTS, clientOf } from "../agents/index.ts";
import { connectApp, connected } from "../connect.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyAs } from "./request.ts";

/** The apps on this computer Grenier can be added to, and the keys apps read the store with over MCP. */
export function appRoutes(deps: AdminDeps): Hono {
  const { store, where } = deps;
  const app = new Hono();

  app.get("/apps", (c) =>
    c.json({
      apps: CLIENTS.map((client) => ({
        app: client.id,
        label: client.label,
        connected: connected(client, where),
      })) satisfies AppView[],
    }),
  );

  app.post("/apps/:app{[\\w-]+}", async (c) => {
    const name = c.req.param("app");
    const client = clientOf(name);
    if (!client) return c.json({ error: `Grenier cannot be added to ${name}` }, 404);
    const { scopes } = await bodyAs(c, z.object({ scopes: z.array(z.string()).default(["*"]) }));
    const file = await connectApp(store, client, scopes, where);
    return c.json({ app: name, file, restart: client.label });
  });

  app.get("/clients", async (c) => {
    return c.json({
      clients: (await store.clients.list())
        .filter((client) => client.revokedAt === null)
        .map((client) => ({ name: client.name, scopes: client.scopes, createdAt: client.createdAt })),
      scopes: ["*", ...TOPS],
    } satisfies Clients);
  });

  app.post("/clients", async (c) => {
    const { name, scopes } = await bodyAs(c, z.object({ name: z.string(), scopes: z.array(z.string()).default([]) }));
    const token = await addClient(store, name, scopes);
    return c.json({ name, scopes, token } satisfies ClientMade, 201);
  });

  app.post("/clients/:name/revoke", async (c) =>
    (await store.clients.revoke(c.req.param("name"), Date.now()))
      ? c.json({ revoked: c.req.param("name") })
      : c.json({ error: `no app named ${c.req.param("name")} reads Grenier` }, 404),
  );

  return app;
}
