import { BUILTIN_TYPES, builtinType, customType, folderProblem, recordProblem } from "@grenier/core";
import {
  addClient,
  check,
  type Found,
  newId,
  query,
  recall,
  retire,
  type StoreDeps,
  StoreUseError,
  type TeamClient,
  TeamError,
  teamApi,
  write,
} from "@grenier/index";
import { buildReport, mostSpentFirst, type Prices, parseSince, projectOf } from "@grenier/log";
import type { FullRecord, RecordInput, Store, UsageWithSession } from "@grenier/store";
import { Hono } from "hono";

export interface AdminHost {
  storeDeps(): Promise<StoreDeps>;
  team(): TeamClient | null;
  syncNow(): Promise<void>;
  /** Each returns null for a path it does not serve. */
  extra?: (method: string, path: string, body: unknown) => Promise<{ status: number; body: unknown } | null>;
}

export interface AdminOptions {
  store: Store;
  prices: Prices;
  token: string;
  version: string;
  host: AdminHost;
  /** Who the daemon is, so a client can tell it from another program that reused its pid. */
  identity?: { pid: number; port: number };
}

function sessionReport(rows: readonly UsageWithSession[], prices: Prices) {
  const sessions = new Map(rows.map((row) => [row.sessionId, row]));
  return buildReport(rows, "session", prices)
    .map((report) => {
      const session = sessions.get(report.key);
      return {
        ...report,
        client: session?.client ?? null,
        project: session ? projectOf(session) : null,
        startedAt: session?.startedAt ?? null,
      };
    })
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** Records Skills, Routines and Settings manage, which Knowledge's tree leaves out. */
const MANAGED_ELSEWHERE = new Set(["Skill", "McpServer", "Routine", "Task", "Type"]);

/** The desktop app's webview: Tauri serves it from these origins; the Vite dev server from the last. */
const APP_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
]);

function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

async function shown(deps: StoreDeps, record: FullRecord, spaces: readonly string[]) {
  const { status, changed } = await check(deps, record);
  const titles = async (ids: readonly string[]) => {
    const out: { id: string; title: string; type: string }[] = [];
    for (const id of ids) {
      const target = await deps.store.records.get(id);
      if (target && spaces.includes(target.space)) out.push({ id, title: target.title, type: target.type });
    }
    return out;
  };
  const backlinks = await deps.store.records.list({ spaces, linkedTo: { kind: "record", ref: record.id } });
  return {
    ...record,
    status,
    changed,
    linksTo: await titles(record.links.filter((link) => link.kind === "record").map((link) => link.ref)),
    linkedFrom: backlinks.map((other) => ({ id: other.id, title: other.title, type: other.type })),
  };
}

export function createAdmin(options: AdminOptions): Hono {
  const { store, prices } = options;
  const host = options.host;
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
    if (error instanceof StoreUseError) return problem(400, error.message);
    if (error instanceof TeamError) return problem(error.status >= 500 ? 502 : error.status, error.detail);
    throw error;
  });

  const deps = () => host.storeDeps();
  /** The desktop app is the person: it reads every space this machine has. */
  const everything = { id: "desktop", name: "desktop", scopes: ["*"] };
  const allSpaces = async () => (await store.spaces.list()).map((space) => space.id);

  app.get("/health", (c) => c.json({ ...options.identity, version: options.version }));

  app.get("/overview", async (c) => {
    const since = parseSince("7d", Date.now());
    const rows = await store.usage.list({ since });
    const team = host.team() ?? null;
    return c.json({
      version: options.version,
      me: (await host.storeDeps()).me.member,
      days: buildReport(rows, "day", prices),
      projects: mostSpentFirst(buildReport(rows, "repo", prices)),
      sessions: sessionReport(rows, prices),
      waiting: team ? new Set((await store.outbox.list()).map((entry) => entry.recordId)).size : 0,
      team: team ? { url: team.url, lastSync: Number((await store.state.get("last_sync")) ?? 0) || null } : null,
      role: team ? ((await store.state.get("team_role")) ?? null) : null,
      paused: (await store.sessions.paused()).length,
    });
  });

  app.get("/spaces", async (c) => {
    const stats = await store.records.stats();
    return c.json({
      spaces: (await store.spaces.list()).map((space) => ({
        ...space,
        records: stats.filter((row) => row.space === space.id).reduce((total, row) => total + row.records, 0),
      })),
    });
  });

  /** Knowledge's tree: every page but the records other screens manage. */
  app.get("/pages", async (c) => {
    const records = await store.records.list({ spaces: await allSpaces(), limit: 100_000 });
    return c.json({
      pages: records
        .filter((record) => !MANAGED_ELSEWHERE.has(record.type))
        .map(({ id, space, folder, title, type, updatedAt }) => ({ id, space, folder, title, type, updatedAt })),
    });
  });

  /** Moves a folder and every page under it: `to` is the folder's new path, in `toSpace` or its own top folder. */
  app.post("/folders/move", async (c) => {
    const body = await c.req
      .json<{ space?: unknown; from?: unknown; to?: unknown; toSpace?: unknown }>()
      .catch(() => ({}) as Record<string, unknown>);
    const space = String(body.space ?? "");
    const from = String(body.from ?? "");
    const to = String(body.to ?? "");
    const toSpace = typeof body.toSpace === "string" ? body.toSpace : space;
    if (from === "" || to === "") return problem(400, "a move names the folder and where it goes");
    const why = folderProblem(to);
    if (why) return problem(400, why);
    if (toSpace === space && (to === from || to.startsWith(`${from}/`))) {
      return problem(400, "a folder cannot move into itself");
    }
    if (toSpace !== "me" && !(await store.spaces.get(toSpace))) return problem(400, `there is no space ${toSpace}`);
    const inside = (await store.records.list({ spaces: [space], limit: 100_000 })).filter(
      (record) => record.folder === from || record.folder.startsWith(`${from}/`),
    );
    for (const before of inside) {
      const { seq: _seq, hits: _hits, ...current } = before;
      const folder = `${to}${before.folder.slice(from.length)}`;
      const result = await save({ ...current, space: toSpace, folder, updatedAt: Date.now() }, before, before.version);
      if ("conflict" in result) return problem(409, `${before.title} changed meanwhile: move the folder again`);
    }
    return c.json({ moved: inside.length });
  });

  app.get("/types", async (c) => {
    const custom = await store.records.list({ spaces: await allSpaces(), type: "Type" });
    return c.json({ types: [...BUILTIN_TYPES, ...custom.map((record) => ({ ...customType(record), id: record.id }))] });
  });

  app.get("/records", async (c) => {
    const storeDeps = await deps();
    const spaces = c.req.query("space") ? [c.req.query("space") as string] : await allSpaces();
    const type = c.req.query("type");
    const words = c.req.query("q")?.trim();
    let records: Found[];
    if (words) {
      records = (
        await recall(storeDeps, everything, {
          query: words,
          repo: null,
          limit: 20,
          count: false,
          ...(type ? { type } : {}),
          ...(c.req.query("space") ? { space: c.req.query("space") as string } : {}),
        })
      ).results;
    } else {
      records = (
        await query(storeDeps, everything, {
          ...(type ? { type } : {}),
          ...(c.req.query("space") ? { space: c.req.query("space") as string } : {}),
          ...(c.req.query("retired") === "1" ? { retired: true } : {}),
          limit: 200,
        })
      ).records;
    }
    return c.json({ records: records.filter((record) => spaces.includes(record.space)) });
  });

  app.get("/records/:id", async (c) => {
    const storeDeps = await deps();
    const record = await store.records.get(c.req.param("id"));
    if (!record) return problem(404, "no such record");
    return c.json(await shown(storeDeps, record, await allSpaces()));
  });

  app.get("/records/:id/history", async (c) => {
    const id = c.req.param("id");
    const team = host.team();
    if (team) {
      try {
        return c.json(await teamApi(team, `/api/records/${encodeURIComponent(id)}/history`));
      } catch {
        // Offline, or a record that never reached the team store: the versions this machine kept.
      }
    }
    return c.json({ history: await store.history.list(id) });
  });

  /** With a team, a field changed since `baseVersion` comes back as a conflict; offline, the latest write wins. */
  async function save(record: RecordInput, before: FullRecord | undefined, baseVersion: number) {
    const storeDeps = await deps();
    const custom = (await store.records.list({ spaces: await allSpaces(), type: "Type" })).find(
      (type) => type.title === record.type,
    );
    const why = recordProblem(record, builtinType(record.type) ?? (custom ? customType(custom) : undefined));
    if (why) throw new StoreUseError(`the record is refused: ${why}`);
    const team = host.team();
    if (team && record.space !== "me" && (await store.spaces.get(record.space))?.kind !== undefined) {
      const changed = ["space", "type", "kind", "title", "folder", "body", "fields", "retiredAt", "links"].filter(
        (key) =>
          !before ||
          JSON.stringify((before as unknown as Record<string, unknown>)[key]) !==
            JSON.stringify((record as unknown as Record<string, unknown>)[key]),
      );
      try {
        const answer = await teamApi<{
          applied: { version: number }[];
          refused: { reason: string }[];
          conflicts: { current: unknown }[];
        }>(team, "/api/changes", {
          body: {
            changes: [{ id: newId(), recordId: record.id, baseVersion, changed, record, check: true }],
          },
        });
        if (answer.conflicts[0]) return { conflict: answer.conflicts[0].current };
        if (answer.refused[0]) throw new StoreUseError(`the team store refused it: ${answer.refused[0].reason}`);
        await store.records.put({ ...record, version: answer.applied[0]?.version ?? record.version });
        await host.syncNow().catch(() => undefined);
        return { saved: record.id };
      } catch (error) {
        if (error instanceof StoreUseError) throw error;
        if (error instanceof TeamError && error.status < 500) throw new StoreUseError(error.detail);
      }
    }
    await write(storeDeps, record, before);
    return { saved: record.id, waiting: true, team: Boolean(team) };
  }

  app.post("/records", async (c) => {
    const storeDeps = await deps();
    const body = await c.req.json<Partial<RecordInput>>().catch(() => ({}) as Partial<RecordInput>);
    const now = Date.now();
    const space = typeof body.space === "string" ? body.space : "team";
    if (space !== "me" && !(await store.spaces.get(space))) return problem(400, `there is no space ${space}`);
    const record: RecordInput = {
      id: newId(),
      space,
      type: typeof body.type === "string" ? body.type : "Doc",
      kind: typeof body.kind === "string" ? body.kind : body.type === "Memory" ? "fact" : null,
      title: String(body.title ?? "").trim(),
      folder: typeof body.folder === "string" ? body.folder : "",
      body: String(body.body ?? ""),
      fields: body.fields && typeof body.fields === "object" ? body.fields : {},
      author: storeDeps.me.member,
      device: storeDeps.me.device,
      sessionId: null,
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
      version: 0,
      anchors: [],
      links: Array.isArray(body.links) ? body.links : [],
    };
    if (record.type === "Memory" && !record.fields.kind) record.fields = { ...record.fields, kind: record.kind };
    const result = await save(record, undefined, 0);
    return c.json({ ...result, id: record.id }, 201);
  });

  app.put("/records/:id", async (c) => {
    const before = await store.records.get(c.req.param("id"));
    if (!before) return problem(404, "no such record");
    const body = await c.req
      .json<Partial<RecordInput> & { baseVersion?: number }>()
      .catch(() => ({}) as Partial<RecordInput> & { baseVersion?: number });
    const { seq: _seq, hits: _hits, ...current } = before;
    const record: RecordInput = {
      ...current,
      ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
      ...(typeof body.folder === "string" ? { folder: body.folder } : {}),
      ...(typeof body.body === "string" ? { body: body.body } : {}),
      ...(body.fields && typeof body.fields === "object" ? { fields: body.fields } : {}),
      ...(Array.isArray(body.links) ? { links: body.links } : {}),
      ...(typeof body.space === "string" ? { space: body.space } : {}),
      updatedAt: Date.now(),
    };
    if (record.type === "Memory") record.kind = String(record.fields.kind ?? record.kind ?? "fact");
    const result = await save(record, before, typeof body.baseVersion === "number" ? body.baseVersion : before.version);
    return "conflict" in result ? c.json(result, 409) : c.json(result);
  });

  app.delete("/records/:id", async (c) =>
    (await retire(await deps(), c.req.param("id")))
      ? c.json({ retired: c.req.param("id") })
      : problem(404, "no such record, or retired already"),
  );

  app.all("/team/*", async (c) => {
    const team = host.team();
    if (!team) return problem(409, "this machine is in no team: grenier team deploy, or open an invite link");
    const path = c.req.path.replace(/^.*?\/team\//, "/api/");
    const body = c.req.method === "GET" || c.req.method === "DELETE" ? undefined : await c.req.json().catch(() => ({}));
    const search = new URL(c.req.url).search;
    return c.json(await teamApi(team, `${path}${search}`, { method: c.req.method, ...(body ? { body } : {}) }));
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

  app.get("/clients", async (c) => {
    const spaces = await store.spaces.list();
    return c.json({
      clients: (await store.clients.list())
        .filter((client) => client.revokedAt === null)
        .map((client) => ({ name: client.name, scopes: client.scopes, createdAt: client.createdAt })),
      scopes: ["*", ...spaces.map((space) => space.id)],
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

  app.all("*", async (c) => {
    const body = c.req.method === "GET" ? undefined : await c.req.json().catch(() => ({}));
    const path = c.req.path.replace(/^\/admin/, "");
    const handled = host.extra ? await host.extra(c.req.method, `${path}${new URL(c.req.url).search}`, body) : null;
    if (!handled) return problem(404, `no ${c.req.method} ${path}`);
    return c.json(handled.body, handled.status as 200);
  });

  return app;
}
