import { syncSources } from "@grenier/connectors";
import { addClient, approveMemory, CacheError, SCOPE_KINDS } from "@grenier/index";
import { buildReport, cacheReport, type GroupBy, type Prices, parseSince } from "@grenier/log";
import type { Source, Store } from "@grenier/store";
import { Hono } from "hono";

export interface AdminOptions {
  store: Store;
  prices: Prices;
  /** The token the desktop app reads from ~/.grenier/admin-token; every /admin call needs it (rule 1). */
  token: string;
  version: string;
  log?: (line: string) => void;
}

/** The desktop app's webview: Tauri serves it from these origins; the Vite dev server from the last. */
const APP_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
]);

const GROUPS: readonly GroupBy[] = ["day", "session", "repo"];
const SOURCE_KINDS = ["markdown", "ics", "caldav", "imap"] as const;

function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/** A source as the app shows it: its config without anything that could be a secret. */
function publicSource(source: Source, items: number) {
  const { password_command: _command, password_env: _env, ...config } = source.config;
  return { name: source.name, kind: source.kind, config, items, lastSync: source.lastSync };
}

function sourceConfig(kind: (typeof SOURCE_KINDS)[number], body: Record<string, unknown>): Record<string, unknown> {
  const text = (key: string) => (typeof body[key] === "string" && body[key] !== "" ? (body[key] as string) : undefined);
  const list = (key: string) =>
    Array.isArray(body[key]) && (body[key] as unknown[]).every((entry) => typeof entry === "string")
      ? (body[key] as string[])
      : undefined;
  const password = () => {
    const command = text("password_command");
    if (command) return { password_command: command.split(" ").filter(Boolean) };
    const env = text("password_env");
    if (env) return { password_env: env };
    throw new CacheError("give password_command (a command printing the password) or password_env");
  };
  switch (kind) {
    case "markdown": {
      const path = text("path");
      if (!path) throw new CacheError("a markdown source needs path");
      return { path };
    }
    case "ics": {
      const url = text("url");
      const path = text("path");
      if (!url && !path) throw new CacheError("an ics source needs url or path");
      return url ? { url } : { path };
    }
    case "caldav": {
      const url = text("url");
      const username = text("username");
      if (!url || !username) throw new CacheError("a caldav source needs url and username");
      const calendars = list("calendars");
      return { url, username, ...password(), ...(calendars ? { calendars } : {}) };
    }
    case "imap": {
      const host = text("host");
      const user = text("user");
      if (!host || !user) throw new CacheError("an imap source needs host and user");
      const mailboxes = list("mailboxes");
      return { host, user, ...password(), ...(mailboxes ? { mailboxes } : {}) };
    }
  }
}

/** The local admin API the desktop app uses: usage, sources, clients and scopes, the audit log, the review queue. */
export function createAdmin(options: AdminOptions): Hono {
  const { store, prices } = options;
  const log = options.log ?? (() => {});
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
          "access-control-allow-methods": "GET, POST, DELETE",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "600",
        },
      });
    }
    if (c.req.header("authorization") !== `Bearer ${options.token}`) {
      return problem(401, "the admin API needs the token in ~/.grenier/admin-token");
    }
    await next();
    if (allowed) c.res.headers.set("access-control-allow-origin", allowed);
    return undefined;
  });

  app.onError((error) => {
    if (error instanceof CacheError) return problem(400, error.message);
    if (error instanceof Error && /--since takes/.test(error.message)) return problem(400, error.message);
    throw error;
  });

  app.get("/overview", async (c) => {
    const since = parseSince("7d", Date.now());
    const rows = await store.usage.list({ since });
    const counts = await store.items.count();
    return c.json({
      version: options.version,
      days: buildReport(rows, "day", prices),
      cache: await store.answers.stats(),
      sources: (await store.sources.list()).length,
      items: counts.reduce((total, row) => total + row.items, 0),
      clients: (await store.clients.list()).filter((client) => client.revokedAt === null).length,
      pendingReview: (await store.review.list("pending")).length,
    });
  });

  app.get("/report", async (c) => {
    const by = (c.req.query("by") ?? "day") as GroupBy;
    if (!GROUPS.includes(by)) return problem(400, "by takes day, session or repo");
    const rows = await store.usage.list({ since: parseSince(c.req.query("since") ?? "7d", Date.now()) });
    return c.json({ rows: buildReport(rows, by, prices), cache: cacheReport(rows) });
  });

  app.get("/sources", async (c) => {
    const counts = new Map((await store.items.count()).map((row) => [row.sourceId, row.items]));
    return c.json({
      sources: (await store.sources.list()).map((source) => publicSource(source, counts.get(source.id) ?? 0)),
    });
  });

  app.post("/sources", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const kind = body.kind as (typeof SOURCE_KINDS)[number];
    const name = body.name;
    if (!SOURCE_KINDS.includes(kind)) return problem(400, `kind takes ${SOURCE_KINDS.join(", ")}`);
    if (typeof name !== "string" || !/^[\w.@-]{1,64}$/.test(name) || [...SCOPE_KINDS, "memory"].includes(name)) {
      return problem(400, `a source name takes letters, digits and . _ @ -, and cannot be ${SCOPE_KINDS.join(", ")}`);
    }
    if (await store.sources.get(name)) return problem(409, `there is already a source named ${name}`);
    await store.sources.add({ id: crypto.randomUUID(), name, kind, config: sourceConfig(kind, body) });
    const [result] = await syncSources(store, log, name);
    return c.json({ added: name, sync: result ?? null }, 201);
  });

  app.post("/sources/:name/sync", async (c) => {
    const results = await syncSources(store, log, c.req.param("name"));
    if (results.length === 0) return problem(404, `no source named ${c.req.param("name")}`);
    return c.json({ sync: results[0] });
  });

  app.delete("/sources/:name", async (c) => {
    const name = c.req.param("name");
    if (name === "memory") return problem(400, "the memory source stays");
    return (await store.sources.remove(name)) ? c.json({ removed: name }) : problem(404, `no source named ${name}`);
  });

  app.get("/clients", async (c) =>
    c.json({
      clients: (await store.clients.list())
        .filter((client) => client.revokedAt === null)
        .map((client) => ({ name: client.name, scopes: client.scopes, createdAt: client.createdAt })),
      scopes: [...SCOPE_KINDS, ...(await store.sources.list()).filter((s) => s.kind !== "memory").map((s) => s.name)],
    }),
  );

  app.post("/clients", async (c) => {
    const body = await c.req
      .json<{ name?: unknown; scopes?: unknown }>()
      .catch(() => ({}) as { name?: unknown; scopes?: unknown });
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    const known = new Set<string>([...SCOPE_KINDS, ...(await store.sources.list()).map((source) => source.name)]);
    const unknown = scopes.filter((scope) => !known.has(scope));
    if (unknown.length > 0) return problem(400, `unknown scope ${unknown.join(", ")}`);
    if (typeof body.name !== "string") return problem(400, "name is required");
    const token = await addClient(store, body.name, scopes);
    return c.json({ name: body.name, scopes, token }, 201);
  });

  app.post("/clients/:name/revoke", async (c) =>
    (await store.clients.revoke(c.req.param("name"), Date.now()))
      ? c.json({ revoked: c.req.param("name") })
      : problem(404, `no active client named ${c.req.param("name")}`),
  );

  app.get("/audit", async (c) => {
    const clients = await store.clients.list();
    const names = new Map(clients.map((client) => [client.id, client.name.replace(/~\d+$/, " (revoked)")]));
    const wanted = c.req.query("client");
    const client = wanted ? clients.find((entry) => entry.name === wanted) : undefined;
    if (wanted && !client) return problem(404, `no client named ${wanted}`);
    const entries = await store.audit.list({
      since: parseSince(c.req.query("since") ?? "7d", Date.now()),
      ...(client ? { clientId: client.id } : {}),
      limit: 500,
    });
    return c.json({
      entries: entries.map((entry) => ({ ...entry, client: names.get(entry.clientId) ?? entry.clientId })),
    });
  });

  app.get("/review", async (c) => {
    const names = new Map((await store.clients.list()).map((client) => [client.id, client.name.replace(/~\d+$/, "")]));
    return c.json({
      pending: (await store.review.list("pending")).map((entry) => ({
        ...entry,
        client: names.get(entry.clientId) ?? entry.clientId,
      })),
    });
  });

  app.post("/review/:id/approve", async (c) =>
    (await approveMemory({ store }, c.req.param("id")))
      ? c.json({ approved: c.req.param("id") })
      : problem(404, `no pending memory ${c.req.param("id")}`),
  );

  app.post("/review/:id/reject", async (c) =>
    (await store.review.decide(c.req.param("id"), "rejected", Date.now()))
      ? c.json({ rejected: c.req.param("id") })
      : problem(404, `no pending memory ${c.req.param("id")}`),
  );

  return app;
}
