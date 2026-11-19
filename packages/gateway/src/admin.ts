import { homedir } from "node:os";
import { commandWords, localPath, syncSources } from "@grenier/connectors";
import { type Config, effectiveLimits, WARN_AT } from "@grenier/core";
import {
  addClient,
  approveMemory,
  CacheError,
  forgetAnswer,
  type RepoFiles,
  SCOPE_KINDS,
  scopeNames,
} from "@grenier/index";
import {
  buildReport,
  cacheReport,
  folderName,
  type GroupBy,
  mostSpentFirst,
  type Prices,
  parseSince,
  projectOf,
  startOfToday,
} from "@grenier/log";
import type { BudgetScope, Source, Store, UsageWithSession } from "@grenier/store";
import { Hono } from "hono";

export interface AdminOptions {
  store: Store;
  prices: Prices;
  /** The token the desktop app reads from ~/.grenier/admin-token; every /admin call needs it. */
  token: string;
  version: string;
  log?: (line: string) => void;
  /** A text file of a repository's work tree, or null when it cannot be shown. Without it, traces show no code. */
  readFile?: (root: string, path: string) => Promise<string | null>;
  /** The files' current blob hashes, to say which cached answers are stale. Without it, none is said to be. */
  files?: Pick<RepoFiles, "hashes">;
  /** The config file's limits, which a limit set here or with `grenier budget set` replaces. */
  budgets?: Config["budgets"];
  /** Who the daemon is, so a client can tell it from another program that reused its pid. */
  identity?: { pid: number; port: number };
}

/** Where each repository is on this machine: the root it was shared from, else the latest session's. */
async function repoRoots(store: Store): Promise<Map<string, string>> {
  const roots = new Map<string, string>();
  for (const session of await store.sessions.list()) {
    if (session.repoId && session.repoRoot) roots.set(session.repoId, session.repoRoot);
  }
  for (const repo of await store.team.repos()) roots.set(repo.repoId, repo.root);
  return roots;
}

/**
 * Each session's spending, the newest first, with where it ran and its questions to the exploration cache: null
 * outside a repository, where no step is traced.
 */
async function sessionReport(store: Store, rows: readonly UsageWithSession[], prices: Prices, since: number) {
  const traced = new Map((await store.steps.sessions(since)).map((summary) => [summary.sessionId, summary]));
  const sessions = new Map(rows.map((row) => [row.sessionId, row]));
  return buildReport(rows, "session", prices)
    .map((report) => {
      const session = sessions.get(report.key);
      const steps = session?.repoRoot ? (traced.get(report.key) ?? { asks: 0, hits: 0 }) : null;
      return {
        ...report,
        client: session?.client ?? null,
        project: session ? projectOf(session) : null,
        startedAt: session?.startedAt ?? null,
        asks: steps?.asks ?? null,
        hits: steps?.hits ?? null,
        traced: traced.has(report.key),
      };
    })
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

const BUDGET_SCOPES: readonly BudgetScope[] = ["daily", "session", "repo"];

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
    if (command) return { password_command: commandWords(command) };
    const env = text("password_env");
    if (env) return { password_env: env };
    throw new CacheError("give password_command (a command printing the password) or password_env");
  };
  switch (kind) {
    case "markdown": {
      const path = text("path");
      if (!path) throw new CacheError("a markdown source needs path");
      return { path: localPath(path, homedir()) };
    }
    case "ics": {
      const url = text("url");
      const path = text("path");
      if (!url && !path) throw new CacheError("an ics source needs url or path");
      return url ? { url } : { path: localPath(path as string, homedir()) };
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
      // The app's own origin gets the header even here, so it can read the 401 instead of seeing no answer.
      const refused = problem(401, "the admin API needs the token in ~/.grenier/admin-token");
      if (allowed) refused.headers.set("access-control-allow-origin", allowed);
      return refused;
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

  app.get("/health", (c) => c.json({ ...options.identity, version: options.version }));

  /** Today's daily and project limits that spending has passed 80% of, or reached. */
  async function limitsToday(rows: readonly UsageWithSession[]) {
    const stored = await store.budgets.list();
    const limits = [
      ...effectiveLimits(options.budgets ?? {}, stored, null).filter((limit) => limit.scope === "daily"),
      ...stored
        .filter((budget) => budget.scope === "repo")
        .map((budget) => ({ scope: "repo" as const, key: budget.key, limit: budget.limitAmount })),
    ];
    if (limits.length === 0) return [];
    const today = rows.filter((row) => row.ts >= startOfToday(Date.now()));
    const spentBy = (project: string | null) =>
      today
        .filter((row) => project === null || projectOf(row) === project)
        .reduce((sum, row) => sum + (row.cost ?? 0), 0);
    return limits
      .map((limit) => ({ ...limit, spent: spentBy(limit.scope === "daily" ? null : limit.key) }))
      .filter((limit) => limit.spent >= limit.limit * WARN_AT)
      .map((limit) => ({ ...limit, reached: limit.spent >= limit.limit }));
  }

  app.get("/overview", async (c) => {
    const since = parseSince("7d", Date.now());
    const rows = await store.usage.list({ since });
    const counts = await store.items.count();
    return c.json({
      version: options.version,
      days: buildReport(rows, "day", prices),
      projects: mostSpentFirst(buildReport(rows, "repo", prices)),
      limits: await limitsToday(rows),
      sessions: await sessionReport(store, rows, prices, since),
      cache: await store.answers.stats(),
      sources: (await store.sources.list()).length,
      items: counts.reduce((total, row) => total + row.items, 0),
      clients: (await store.clients.list()).filter((client) => client.revokedAt === null).length,
      pendingReview: (await store.review.list("pending")).length,
      paused: (await store.sessions.paused()).length,
    });
  });

  app.get("/report", async (c) => {
    const by = (c.req.query("by") ?? "day") as GroupBy;
    if (!GROUPS.includes(by)) return problem(400, "by takes day, session or repo");
    const rows = await store.usage.list({ since: parseSince(c.req.query("since") ?? "7d", Date.now()) });
    return c.json({ rows: buildReport(rows, by, prices), cache: cacheReport(rows) });
  });

  app.get("/traces", async (c) => {
    const summaries = await store.steps.sessions(parseSince(c.req.query("since") ?? "30d", Date.now()));
    const traces: Record<string, unknown>[] = [];
    for (const summary of summaries) {
      const session = await store.sessions.get(summary.sessionId);
      if (!session?.repoRoot) continue;
      const { steps, files, last, asks, hits, readsBeforeAsk } = summary;
      const { id, client, startedAt, endedAt } = session;
      const repo = projectOf(session);
      traces.push({ id, client, repo, startedAt, endedAt, steps, files, last, asks, hits, readsBeforeAsk });
    }
    return c.json({ traces });
  });

  app.get("/traces/:id", async (c) => {
    const session = await store.sessions.get(c.req.param("id"));
    if (!session?.repoRoot) return problem(404, `no trace for session ${c.req.param("id")}`);
    const usage = await store.usage.list({ sessionId: session.id });
    return c.json({
      id: session.id,
      client: session.client,
      repo: projectOf(session),
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      steps: (await store.steps.list(session.id)).map(({ sessionId: _session, ...step }) => step),
      requests: usage.map((row) => ({ ts: row.ts, cost: row.cost ?? 0 })),
    });
  });

  // Only a file the session itself touched, read where the session's repository is now.
  app.get("/traces/:id/file", async (c) => {
    const path = c.req.query("path") ?? "";
    const session = await store.sessions.get(c.req.param("id"));
    const touched =
      session?.repoRoot && options.readFile && (await store.steps.list(session.id)).some((step) => step.path === path);
    const text = touched ? await options.readFile?.(session.repoRoot as string, path) : null;
    if (typeof text !== "string") {
      return problem(404, `${path} cannot be shown: it is not a text file this session touched, or it is gone`);
    }
    return c.json({ path, text });
  });

  app.get("/cache", async (c) => {
    const roots = await repoRoots(store);
    const answers = new Map((await store.answers.stats()).map((row) => [row.repoId, row]));
    const summaries = new Map((await store.summaries.stats()).map((row) => [row.repoId, row.summaries]));
    const shared = new Set((await store.team.repos()).map((repo) => repo.repoId));
    const ids = [...new Set([...answers.keys(), ...summaries.keys()])];
    const name = (id: string) => {
      const root = roots.get(id);
      return root ? folderName(root) : id.slice(0, 12);
    };
    return c.json({
      repos: ids
        .map((id) => ({
          id,
          name: name(id),
          answers: answers.get(id)?.answers ?? 0,
          hits: answers.get(id)?.hits ?? 0,
          summaries: summaries.get(id) ?? 0,
          shared: shared.has(id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  // An answer's `changed` is null when its repository is not on this machine, so whether it is stale is unknown.
  app.get("/cache/:repo", async (c) => {
    const id = c.req.param("repo");
    const root = (await repoRoots(store)).get(id);
    const answers = await store.answers.list(id);
    const paths = [...new Set(answers.flatMap((answer) => answer.sources.map((source) => source.path)))];
    const current =
      root && options.files && paths.length > 0 ? await options.files.hashes(root, paths).catch(() => null) : null;
    return c.json({
      answers: answers.map((answer) => ({
        id: answer.id,
        question: answer.question,
        answer: answer.answer,
        author: answer.author,
        createdAt: answer.createdAt,
        hits: answer.hits,
        shared: answer.shared,
        shareError: answer.shareError,
        files: answer.sources.map((source) => source.path),
        changed: current
          ? answer.sources.filter((source) => current.get(source.path) !== source.blobHash).map((source) => source.path)
          : null,
      })),
    });
  });

  app.delete("/cache/answers/:id", async (c) => {
    const forgotten = await forgetAnswer(store, c.req.param("id"));
    if (!forgotten) return problem(404, `no answer ${c.req.param("id")} in the cache`);
    return c.json({ forgotten: c.req.param("id"), shared: forgotten.shared });
  });

  app.get("/budgets", async (c) => {
    const stored = await store.budgets.list();
    const find = (scope: BudgetScope, key = "") =>
      stored.find((budget) => budget.scope === scope && budget.key === key)?.limitAmount ?? null;
    const projects = (await store.sessions.list()).map(projectOf).filter((project) => project !== null);
    return c.json({
      daily: find("daily") ?? options.budgets?.daily ?? null,
      session: find("session") ?? options.budgets?.session ?? null,
      fromConfig: {
        daily: find("daily") === null && options.budgets?.daily !== undefined,
        session: find("session") === null && options.budgets?.session !== undefined,
      },
      repos: stored
        .filter((budget) => budget.scope === "repo")
        .map((budget) => ({ name: budget.key, limit: budget.limitAmount })),
      known: [...new Set(projects)].sort(),
      spentToday: await store.usage.spend({ since: startOfToday(Date.now()) }),
    });
  });

  app.post("/budgets", async (c) => {
    const body = await c.req
      .json<{ scope?: unknown; key?: unknown; limit?: unknown }>()
      .catch(() => ({}) as { scope?: unknown; key?: unknown; limit?: unknown });
    const scope = body.scope as BudgetScope;
    if (!BUDGET_SCOPES.includes(scope)) return problem(400, `scope takes ${BUDGET_SCOPES.join(", ")}`);
    const key = scope === "repo" ? body.key : "";
    if (typeof key !== "string" || (scope === "repo" && !/^[^\s=]{1,128}$/.test(key))) {
      return problem(400, "a repo limit needs the project's folder name as key");
    }
    if (body.limit === null) {
      await store.budgets.remove(scope, key);
      return c.json({ removed: { scope, key } });
    }
    if (typeof body.limit !== "number" || !Number.isFinite(body.limit) || body.limit < 0) {
      return problem(400, "limit takes an amount in dollars, or null to remove it");
    }
    await store.budgets.set(scope, key, body.limit);
    return c.json({ set: { scope, key, limit: body.limit } });
  });

  app.get("/sessions/paused", async (c) => {
    const loops = await store.events.list({ kind: "pause" });
    return c.json({
      sessions: (await store.sessions.paused()).map((session) => ({
        id: session.id,
        client: session.client,
        repo: projectOf(session),
        pausedAt: loops.filter((event) => event.sessionId === session.id).at(-1)?.ts ?? null,
      })),
    });
  });

  app.post("/sessions/:id/resume", async (c) => {
    const session = await store.sessions.get(c.req.param("id"));
    if (!session) return problem(404, `no session ${c.req.param("id")}`);
    if (!session.paused) return c.json({ resumed: null });
    await store.sessions.setPaused(session.id, false);
    await store.events.add({ sessionId: session.id, ts: Date.now(), kind: "resume", detail: null });
    return c.json({ resumed: session.id });
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

  app.get("/clients", async (c) => {
    const sources = await store.sources.list();
    return c.json({
      clients: (await store.clients.list())
        .filter((client) => client.revokedAt === null)
        .map((client) => ({
          name: client.name,
          scopes: scopeNames(client.scopes, sources),
          createdAt: client.createdAt,
        })),
      scopes: [...SCOPE_KINDS, ...sources.filter((s) => s.kind !== "memory").map((s) => s.name)],
    });
  });

  app.post("/clients", async (c) => {
    const body = await c.req
      .json<{ name?: unknown; scopes?: unknown }>()
      .catch(() => ({}) as { name?: unknown; scopes?: unknown });
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
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
