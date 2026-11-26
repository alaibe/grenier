import { StoreUseError } from "@grenier/index";
import type { Context, Hono } from "hono";
import { Refusal } from "../io.ts";

/** A request's JSON body as an object: the app sends some requests without one, which read as empty. */
export async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/** The `id` a route names in its query, as a skill's, a server's or an instructions file's. */
export const queryId = (c: Context) => String(c.req.query("id") ?? "");

/** What a route looked for and did not find: a 404 with this message. */
export class Missing extends Refusal {
  override name = "Missing";
}

/** Routes whose writes the team store may refuse: that refusal is a conflict, as their other refusals. */
export function storeConflicts(app: Hono): Hono {
  app.onError((error) => {
    if (error instanceof StoreUseError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  });
  return app;
}
