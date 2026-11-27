import { StoreUseError } from "@grenier/index";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import { Refusal } from "../io.ts";

/** A request's JSON body as an object: the app sends some requests without one, which read as empty. */
export async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/** A request's JSON body read by its schema; one that doesn't fit is refused, as a 400, with what is wrong. */
export async function bodyAs<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const read = schema.safeParse(await bodyOf(c));
  if (read.success) return read.data;
  const issue = read.error.issues[0];
  throw new StoreUseError(`${issue?.path.join(".") || "the request"}: ${issue?.message ?? "not as expected"}`);
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
