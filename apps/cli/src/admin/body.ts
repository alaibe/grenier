import type { Context } from "hono";

/** A request's JSON body as an object: the app sends some requests without one, which read as empty. */
export async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}
