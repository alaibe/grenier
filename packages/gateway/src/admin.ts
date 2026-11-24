import { folderProblem } from "@grenier/core";
import {
  addClient,
  check,
  embedding,
  type Found,
  newId,
  query,
  recall,
  refusal,
  retire,
  type StoreDeps,
  StoreUseError,
  TEAM_PROTOCOL,
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

async function shown(deps: StoreDeps, record: FullRecord, tops: readonly string[]) {
  const { status, changed } = await check(deps, record);
  const titles = async (ids: readonly string[]) => {
    const out: { id: string; title: string; type: string }[] = [];
    for (const id of ids) {
      const target = await deps.store.records.get(id);
      if (target && tops.includes(target.top)) out.push({ id, title: target.title, type: target.type });
    }
    return out;
  };
  const backlinks = await deps.store.records.list({ tops, linkedTo: { kind: "record", ref: record.id } });
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
    // The app reads a 401 as its own admin token refused: the team store's means this machine was removed.
    if (error instanceof TeamError && error.status === 401) {
      return problem(409, "the team store no longer knows this machine: it was removed from the team");
    }
    if (error instanceof TeamError) return problem(error.status >= 500 ? 502 : error.status, error.detail);
    throw error;
  });

  const deps = () => host.storeDeps();
  /** The desktop app is the person: it reads every top folder this machine has. */
  const everything = { id: "desktop", name: "desktop", scopes: ["*"] };
  const allTops = async () => (await store.tops.list()).map((top) => top.id);

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
      outdated: team ? Number((await store.state.get("team_protocol")) ?? TEAM_PROTOCOL) < TEAM_PROTOCOL : false,
      paused: (await store.sessions.paused()).length,
    });
  });

  app.get("/tops", async (c) => {
    const stats = await store.records.stats();
    return c.json({
      tops: (await store.tops.list()).map((top) => ({
        ...top,
        records: stats.filter((row) => row.top === top.id).reduce((total, row) => total + row.records, 0),
      })),
    });
  });

  /** Knowledge's tree: every page but the records other screens manage. */
  app.get("/pages", async (c) => {
    const records = await store.records.list({ tops: await allTops(), limit: 100_000 });
    return c.json({
      pages: records
        .filter((record) => !MANAGED_ELSEWHERE.has(record.type))
        .map(({ id, top, folder, title, type, updatedAt }) => ({ id, top, folder, title, type, updatedAt })),
    });
  });

  /** Moves a folder and every page under it: `to` is the folder's new path, in `toTop` or its own top folder. */
  app.post("/folders/move", async (c) => {
    const body = await c.req
      .json<{ top?: unknown; from?: unknown; to?: unknown; toTop?: unknown }>()
      .catch(() => ({}) as Record<string, unknown>);
    const top = String(body.top ?? "");
    const from = String(body.from ?? "");
    const to = String(body.to ?? "");
    const toTop = typeof body.toTop === "string" ? body.toTop : top;
    if (from === "" || to === "") return problem(400, "a move names the folder and where it goes");
    const why = folderProblem(to);
    if (why) return problem(400, why);
    if (toTop === top && (to === from || to.startsWith(`${from}/`))) {
      return problem(400, "a folder cannot move into itself");
    }
    if (toTop !== "me" && !(await store.tops.get(toTop))) return problem(400, `there is no top folder ${toTop}`);
    const inside = (await store.records.list({ tops: [top], limit: 100_000 })).filter(
      (record) => record.folder === from || record.folder.startsWith(`${from}/`),
    );
    for (const before of inside) {
      const { seq: _seq, hits: _hits, ...current } = before;
      const folder = `${to}${before.folder.slice(from.length)}`;
      const result = await save({ ...current, top: toTop, folder, updatedAt: Date.now() }, before, before.version);
      if ("conflict" in result) return problem(409, `${before.title} changed meanwhile: move the folder again`);
    }
    return c.json({ moved: inside.length });
  });

  app.get("/records", async (c) => {
    const storeDeps = await deps();
    const tops = c.req.query("top") ? [c.req.query("top") as string] : await allTops();
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
          ...(c.req.query("top") ? { top: c.req.query("top") as string } : {}),
        })
      ).results;
    } else {
      records = (
        await query(storeDeps, everything, {
          ...(type ? { type } : {}),
          ...(c.req.query("top") ? { top: c.req.query("top") as string } : {}),
          ...(c.req.query("retired") === "1" ? { retired: true } : {}),
          limit: 200,
        })
      ).records;
    }
    return c.json({ records: records.filter((record) => tops.includes(record.top)) });
  });

  app.get("/records/:id", async (c) => {
    const storeDeps = await deps();
    const record = await store.records.get(c.req.param("id"));
    if (!record) return problem(404, "no such record");
    return c.json(await shown(storeDeps, record, await allTops()));
  });

  app.get("/records/:id/history", async (c) => {
    const id = c.req.param("id");
    const team = host.team();
    // The team store keeps a Me page sealed, so its versions say nothing: this machine's own do.
    if (team && (await store.records.get(id))?.top !== "me") {
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
    const why = await refusal(store, record, before);
    if (why) throw new StoreUseError(`the record is refused: ${why}`);
    const team = host.team();
    // Straight to the team store only once a sync found it speaks this Grenier's protocol; else it waits here.
    const current = Number((await store.state.get("team_protocol")) ?? 0) >= TEAM_PROTOCOL;
    const top = await store.tops.get(record.top);
    if (team && current && record.top !== "me" && top) {
      const changed = ["top", "type", "kind", "title", "folder", "body", "fields", "retiredAt", "links"].filter(
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
            changes: [
              {
                id: newId(),
                recordId: record.id,
                baseVersion,
                changed,
                // As sync sends it: the store names a repository's folder it has not seen yet.
                record: top.kind === "repo" ? { ...record, topName: top.name } : record,
                check: true,
              },
            ],
          },
        });
        if (answer.conflicts[0]) return { conflict: answer.conflicts[0].current };
        if (answer.refused[0]) throw new StoreUseError(`the team store refused it: ${answer.refused[0].reason}`);
        await store.records.put(
          { ...record, version: answer.applied[0]?.version ?? record.version },
          await embedding(storeDeps, record),
        );
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
    const top = typeof body.top === "string" ? body.top : "team";
    if (top !== "me" && !(await store.tops.get(top))) return problem(400, `there is no top folder ${top}`);
    const record: RecordInput = {
      id: newId(),
      top,
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
      ...(typeof body.top === "string" ? { top: body.top } : {}),
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
    if (!team) return problem(409, "this machine is in no team: start or join one on the app's Team screen");
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
    const tops = await store.tops.list();
    return c.json({
      clients: (await store.clients.list())
        .filter((client) => client.revokedAt === null)
        .map((client) => ({ name: client.name, scopes: client.scopes, createdAt: client.createdAt })),
      scopes: ["*", ...tops.map((top) => top.id)],
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
