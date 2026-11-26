import { DurableObject } from "cloudflare:workers";
import { sha256 } from "@grenier/core/policy";
import { builtinType, customType, joinCode, MEMBER_WRITES, memberMay, recordProblem } from "@grenier/core/records";
import { RECORD_PARTS, TEAM_PROTOCOL } from "@grenier/core/team";
import { Hono } from "hono";
import {
  type Applied,
  adminOnly,
  type Change,
  type Device,
  type Member,
  problem,
  type Row,
  randomId,
  SEEN,
  type StoredRecord,
  type TeamApp,
  type TeamData,
  type Vars,
} from "./data.ts";
import { mcpRoutes } from "./mcp.ts";
import { SCHEMA_STEPS } from "./schema.ts";
import { fileDue, schedule, workRoutes } from "./work.ts";

export interface Env {
  TEAM: DurableObjectNamespace<TeamStore>;
  /** The SHA-256 of the token the deploy made, which sets up the first admin, once. */
  SETUP_HASH?: string;
}

/** What a change may set: the parts it carries, and the seal of a `me` record. */
const RECORD_FIELDS: readonly string[] = [...RECORD_PARTS, "sealed"];
const INVITE_LIFE = 24 * 60 * 60 * 1000;
const CONFIRM_WINDOW = 10 * 60 * 1000;
const MAX_BATCH = 500;

/** One team's store; being one Durable Object, it puts every change in order. */
export class TeamStore extends DurableObject<Env> {
  #app: TeamApp;
  /** Who has which record open in an editor, by record id: kept in memory, gone after a minute without news. */
  #open = new Map<string, Map<string, { member: string; device: string; at: number }>>();
  #data: TeamData = {
    storage: this.ctx.storage,
    sql: (query, ...bindings) => this.#sql(query, ...bindings),
    one: (query, ...bindings) => this.#one(query, ...bindings),
    record: (row) => this.#record(row),
    get: (id) => this.#get(id),
    put: (record, member, device) => this.#put(record, member, device),
    nextVersion: () => this.#nextVersion(),
    topsOf: (member) => this.#topsOf(member),
    apply: (change, member, device) => this.#apply(change, member, device),
    authenticate: (request) => this.#authenticate(request),
    notify: () => this.#notify(),
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#migrate();
    this.#app = this.#routes();
  }

  #sql(query: string, ...bindings: SqlStorageValue[]): Row[] {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray() as Row[];
  }

  #one(query: string, ...bindings: SqlStorageValue[]): Row | undefined {
    return this.#sql(query, ...bindings)[0];
  }

  #migrate(): void {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const schema = Number(this.#one("SELECT value FROM meta WHERE key = 'schema'")?.value ?? 0);
    for (const step of SCHEMA_STEPS.slice(schema)) this.ctx.storage.sql.exec(step);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") === "websocket") return this.#live(request);
    return this.#app.fetch(request, this.env);
  }

  // Live connection: the store tells each device when there is something new; devices tell it their state.

  async #live(request: Request): Promise<Response> {
    // A WebSocket client that cannot send headers names its token as a subprotocol: "grenier, <token>".
    const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((part) => part.trim());
    const fromProtocol = offered[0] === "grenier" && offered[1] ? offered[1] : null;
    const headers = new Headers(request.headers);
    if (fromProtocol) headers.set("authorization", `Bearer ${fromProtocol}`);
    const device = await this.#authenticate(new Request(request.url, { headers }));
    if (!device) return problem(401, "a valid device token is needed");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [device.device.id]);
    pair[1].send(JSON.stringify({ type: "version", version: this.#version() }));
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      ...(fromProtocol ? { headers: { "sec-websocket-protocol": "grenier" } } : {}),
    });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const [deviceId] = this.ctx.getTags(socket);
    if (!deviceId || typeof message !== "string") return;
    try {
      const data = JSON.parse(message) as { type?: string };
      if (data.type === "state") this.#setState(deviceId, data as unknown as MachineState);
    } catch {
      // A malformed message changes nothing.
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    const [deviceId] = this.ctx.getTags(socket);
    if (deviceId && this.ctx.getWebSockets(deviceId).length === 0) {
      this.#sql("UPDATE devices SET state = 'offline', state_at = ? WHERE id = ?", Date.now(), deviceId);
    }
  }

  #notify(): void {
    const message = JSON.stringify({ type: "version", version: this.#version() });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // A socket closing as we send is told at its next connection.
      }
    }
  }

  async #authenticate(request: Request): Promise<{ member: Member; device: Device } | null> {
    const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return null;
    const row = this.#one(
      `SELECT d.id, d.name, d.member_id, m.name AS member_name, m.role FROM devices d JOIN members m ON m.id = d.member_id
       WHERE d.token_hash = ? AND d.revoked_at IS NULL AND m.removed_at IS NULL`,
      await sha256(token),
    );
    if (!row) return null;
    this.#sql("UPDATE devices SET last_seen = ? WHERE id = ?", Date.now(), row.id as string);
    return {
      member: { id: row.member_id as string, name: row.member_name as string, role: row.role as Member["role"] },
      device: { id: row.id as string, name: row.name as string, memberId: row.member_id as string },
    };
  }

  #version(): number {
    return Number(this.#one("SELECT value FROM meta WHERE key = 'version'")?.value ?? 0);
  }

  #nextVersion(): number {
    const next = this.#version() + 1;
    this.#sql("UPDATE meta SET value = ? WHERE key = 'version'", String(next));
    return next;
  }

  /** The top folders a member reads: the team's, the repositories', and their own `me`. */
  #topsOf(member: Member): string[] {
    return [...this.#sql("SELECT id FROM tops").map((top) => top.id as string), `me:${member.id}`];
  }

  #record(row: Row): StoredRecord {
    return {
      id: row.id as string,
      top: row.top as string,
      type: row.type as string,
      kind: (row.kind as string | null) ?? null,
      title: row.title as string,
      folder: (row.folder as string | null) ?? "",
      body: row.body as string,
      fields: JSON.parse(row.fields as string),
      author: row.author as string,
      device: (row.device as string | null) ?? null,
      sessionId: (row.session_id as string | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      retiredAt: (row.retired_at as number | null) ?? null,
      version: row.version as number,
      anchors: JSON.parse(row.anchors as string),
      links: JSON.parse(row.links as string),
      sealed: (row.sealed as string | null) ?? null,
    };
  }

  #get(id: string): StoredRecord | undefined {
    const row = this.#one("SELECT * FROM records WHERE id = ?", id);
    return row ? this.#record(row) : undefined;
  }

  #put(record: StoredRecord, member: Member, device: Device): void {
    this.#sql("DELETE FROM records_fts WHERE id = ?", record.id);
    this.#sql(
      `INSERT INTO records (id, top, type, kind, title, folder, body, fields, author, device, session_id, created_at,
        updated_at, retired_at, version, anchors, links, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET top = excluded.top, type = excluded.type, kind = excluded.kind,
        title = excluded.title, folder = excluded.folder, body = excluded.body, fields = excluded.fields, author = excluded.author,
        device = excluded.device, session_id = excluded.session_id, updated_at = excluded.updated_at,
        retired_at = excluded.retired_at, version = excluded.version, anchors = excluded.anchors,
        links = excluded.links, sealed = excluded.sealed`,
      record.id,
      record.top,
      record.type,
      record.kind,
      record.title,
      record.folder,
      record.body,
      JSON.stringify(record.fields),
      record.author,
      record.device,
      record.sessionId,
      record.createdAt,
      record.updatedAt,
      record.retiredAt,
      record.version,
      JSON.stringify(record.anchors),
      JSON.stringify(record.links),
      record.sealed,
    );
    if (record.sealed === null && record.retiredAt === null) {
      this.#sql("INSERT INTO records_fts (id, title, body) VALUES (?, ?, ?)", record.id, record.title, record.body);
    }
    const { sealed: _sealed, ...snapshot } = record;
    this.#sql(
      "INSERT OR IGNORE INTO history (record_id, version, author, device, ts, snapshot) VALUES (?, ?, ?, ?, ?, ?)",
      record.id,
      record.version,
      member.name,
      device.name,
      record.updatedAt,
      JSON.stringify(record.sealed === null ? snapshot : { sealed: true }),
    );
  }

  /** Applies one change, field by field over what the store has; the store's order decides between two writers. */
  #apply(change: Change, member: Member, device: Device): Applied {
    const done = this.#one("SELECT version FROM applied WHERE change_id = ?", change.id);
    if (done) return { version: done.version as number };
    const tops = this.#topsOf(member);
    const current = this.#get(change.recordId);
    if (current && !tops.includes(current.top)) return { refused: "this record is in a top folder you do not read" };
    const changed = change.changed.filter((name) => RECORD_FIELDS.includes(name));
    // Filed under Team by default, a new record that names no top folder could be someone's `me` page.
    if (!current && !changed.includes("top")) return { refused: "a new record names its top folder" };
    if (current && change.check && change.baseVersion < current.version) {
      const since = this.#sql(
        "SELECT snapshot FROM history WHERE record_id = ? AND version > ? ORDER BY version",
        change.recordId,
        change.baseVersion,
      );
      const base = this.#one(
        "SELECT snapshot FROM history WHERE record_id = ? AND version = ?",
        change.recordId,
        change.baseVersion,
      );
      const before = base ? (JSON.parse(base.snapshot as string) as Record<string, unknown>) : {};
      const touched = new Set<string>();
      for (const entry of since) {
        const snapshot = JSON.parse(entry.snapshot as string) as Record<string, unknown>;
        for (const name of RECORD_FIELDS) {
          if (JSON.stringify(snapshot[name]) !== JSON.stringify(before[name])) touched.add(name);
        }
      }
      if (changed.some((name) => touched.has(name))) return { conflict: current };
    }
    const now = Date.now();
    const incoming = change.record as Record<string, unknown>;
    const next: StoredRecord = {
      ...(current ?? {
        id: change.recordId,
        top: "team",
        type: "Memory",
        kind: null,
        title: "",
        folder: "",
        body: "",
        fields: {},
        author: member.name,
        device: device.name,
        sessionId: null,
        createdAt: now,
        updatedAt: now,
        retiredAt: null,
        version: 0,
        anchors: [],
        links: [],
        sealed: null,
      }),
    };
    for (const name of changed) (next as unknown as Record<string, unknown>)[name] = incoming[name] ?? null;
    next.fields ??= {};
    next.anchors ??= [];
    next.links ??= [];
    next.title ??= "";
    next.folder ??= "";
    next.body ??= "";
    if (next.top === "me") next.top = `me:${member.id}`;
    if (member.role !== "admin") {
      const ran =
        current?.type === "Task" &&
        this.#one("SELECT 1 AS ran FROM runs WHERE task_id = ? AND device_id = ?", current.id, device.id) !== undefined;
      if (!memberMay(current, next, `me:${member.id}`, ran)) return { refused: MEMBER_WRITES };
    }
    if (!tops.includes(next.top)) {
      if (next.top.startsWith("repo:")) {
        this.#sql(
          "INSERT OR IGNORE INTO tops (id, name, kind, repo_id) VALUES (?, ?, 'repo', ?)",
          next.top,
          typeof incoming.topName === "string" ? incoming.topName : next.top.slice(5, 13),
          next.top.slice(5),
        );
      } else return { refused: `there is no top folder ${next.top} you may write to` };
    }
    if (next.sealed !== null && !next.top.startsWith("me:")) return { refused: "only a record in me is sealed" };
    if (next.sealed !== null && next.folder !== "") return { refused: "a sealed record keeps its folder sealed" };
    if (next.sealed === null) {
      const defined = this.#one(
        "SELECT title, body, fields FROM records WHERE type = 'Type' AND title = ? AND retired_at IS NULL",
        next.type,
      );
      const type =
        builtinType(next.type) ??
        (defined
          ? customType({
              title: defined.title as string,
              body: defined.body as string,
              fields: JSON.parse(defined.fields as string),
            })
          : undefined);
      const why = recordProblem(next, type);
      if (why) return { refused: why };
    }
    next.author = member.name;
    next.device = device.name;
    next.sessionId = typeof incoming.sessionId === "string" ? incoming.sessionId : null;
    next.updatedAt = now;
    next.version = this.#nextVersion();
    this.#put(next, member, device);
    this.#sql("INSERT INTO applied (change_id, version, at) VALUES (?, ?, ?)", change.id, next.version, now);
    // An admin changed the routine: every machine that declined its tasks may answer again.
    if (next.type === "Routine") {
      this.#sql(
        "DELETE FROM declines WHERE task_id IN (SELECT id FROM records WHERE type = 'Task' AND json_extract(fields, '$.routine') = ?)",
        next.id,
      );
    }
    if (next.type === "Task" && next.fields.status === "to-do")
      this.#sql("DELETE FROM claims WHERE task_id = ?", next.id);
    return { version: next.version };
  }

  #setState(deviceId: string, state: MachineState): void {
    const allowed = ["available", "busy", "away", "offline"];
    if (!allowed.includes(state.state)) return;
    this.#sql(
      "UPDATE devices SET state = ?, room = ?, agents = ?, state_at = ? WHERE id = ?",
      state.state,
      Number.isFinite(state.room) ? Math.max(0, Math.min(1, state.room)) : 0,
      JSON.stringify(Array.isArray(state.agents) ? state.agents.slice(0, 10).map(String) : []),
      Date.now(),
      deviceId,
    );
  }

  /** Files the task of each scheduled routine that is due, unless the last one it filed is still waiting. */
  override async alarm(): Promise<void> {
    await fileDue(this.#data);
  }

  #routes(): TeamApp {
    const app = new Hono<{ Variables: Vars }>();

    app.onError((error) => problem(500, error.message));

    // Setting up the first admin, with the token the deploy made: once, while the team has no member.
    app.post("/api/setup", async (c) => {
      const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
      if (!token || !this.env.SETUP_HASH || (await sha256(token)) !== this.env.SETUP_HASH) {
        return problem(401, "setting up needs the token the deploy made");
      }
      if (this.#one("SELECT id FROM members LIMIT 1")) return problem(409, "this team is set up already");
      const body = await c.req
        .json<{ member?: unknown; device?: unknown }>()
        .catch(() => ({}) as Record<string, unknown>);
      const name = String(body.member ?? "");
      const deviceName = String(body.device ?? "");
      if (!/^[\w.@-]{1,64}$/.test(name) || !/^[\w.-]{1,40}$/.test(deviceName)) {
        return problem(400, "member takes letters, digits and . _ @ -, device letters, digits and . _ -");
      }
      const memberId = randomId();
      this.#sql(
        "INSERT INTO members (id, name, role, created_at) VALUES (?, ?, 'admin', ?)",
        memberId,
        name,
        Date.now(),
      );
      this.#sql(
        "INSERT INTO devices (id, member_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        randomId(),
        memberId,
        deviceName,
        await sha256(token),
        Date.now(),
      );
      return c.json({ member: name, role: "admin" }, 201);
    });

    // Joining: the device sends the hash of the token it made; it works once an admin confirms the code.
    app.post("/api/join", async (c) => {
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
      const invite = this.#one("SELECT * FROM invites WHERE id = ?", String(body.invite ?? ""));
      const secretHash = typeof body.secret === "string" ? await sha256(body.secret) : "";
      if (
        !invite ||
        invite.secret_hash !== secretHash ||
        invite.used_at !== null ||
        (invite.expires_at as number) < Date.now()
      ) {
        return problem(404, "this invite link is not valid: it was used, it expired, or it was made for another team");
      }
      const device = String(body.device ?? "");
      const tokenHash = String(body.tokenHash ?? "");
      const nonce = String(body.nonce ?? "");
      if (!/^[\w.-]{1,40}$/.test(device) || !/^[0-9a-f]{64}$/.test(tokenHash) || !/^[0-9a-f]{16,64}$/.test(nonce)) {
        return problem(400, "device takes letters, digits and . _ -; tokenHash and nonce are hex");
      }
      this.#sql(
        "UPDATE invites SET device_name = ?, device_hash = ?, nonce = ?, asked_at = ? WHERE id = ?",
        device,
        tokenHash,
        nonce,
        Date.now(),
        invite.id as string,
      );
      return c.json({ waiting: true, member: invite.member_name }, 202);
    });

    // Signing in a browser: a one-time code a device made becomes a token for a device named web.
    app.post("/web/login", async (c) => {
      const { code } = await c.req.json<{ code?: unknown }>().catch(() => ({}) as { code?: unknown });
      const link = this.#one(
        "SELECT * FROM weblinks WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
        await sha256(String(code ?? "")),
        Date.now(),
      );
      if (!link) return problem(404, "this sign-in link was used or expired: make another on the app's Team screen");
      const token = `gt_${randomId(32)}`;
      this.#sql("UPDATE weblinks SET used_at = ? WHERE code_hash = ?", Date.now(), link.code_hash as string);
      this.#sql(
        "INSERT INTO devices (id, member_id, name, token_hash, created_at) VALUES (?, ?, 'web', ?, ?)",
        randomId(),
        link.member_id as string,
        await sha256(token),
        Date.now(),
      );
      return c.json({ token });
    });

    mcpRoutes(app, this.#data);

    // Every other route needs a device's token; a revoked one fails on its next call.
    app.use("/api/*", async (c, next) => {
      const who = await this.#authenticate(c.req.raw);
      if (!who) return problem(401, "a valid device token is needed: Authorization: Bearer <token>");
      c.set("member", who.member);
      c.set("device", who.device);
      return next();
    });

    app.post("/api/weblinks", async (c) => {
      const code = randomId(16);
      this.#sql(
        "INSERT INTO weblinks (code_hash, member_id, expires_at) VALUES (?, ?, ?)",
        await sha256(code),
        c.get("member").id,
        Date.now() + CONFIRM_WINDOW,
      );
      return c.json({ path: `/#login=${code}` }, 201);
    });

    app.get("/api/me", (c) =>
      c.json({
        ...c.get("member"),
        device: c.get("device").name,
        deviceId: c.get("device").id,
        version: this.#version(),
        protocol: TEAM_PROTOCOL,
        me: `me:${c.get("member").id}`,
      }),
    );

    app.put("/api/me/device", async (c) => {
      const { name } = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
      if (typeof name !== "string" || !/^[\w.-]{1,40}$/.test(name))
        return problem(400, "a name takes letters, digits and . _ -");
      this.#sql("UPDATE devices SET name = ? WHERE id = ?", name, c.get("device").id);
      return c.json({ name });
    });

    app.post("/api/invites", adminOnly, async (c) => {
      const body = await c.req.json<{ name?: unknown; role?: unknown }>().catch(() => ({}) as Record<string, unknown>);
      const name = String(body.name ?? "");
      const role = body.role === "admin" ? "admin" : "member";
      if (!/^[\w.@-]{1,64}$/.test(name)) return problem(400, "a name takes letters, digits and . _ @ -");
      const existing = this.#one("SELECT role FROM members WHERE name = ? AND removed_at IS NULL", name);
      const id = randomId(8);
      const secret = randomId(16);
      this.#sql(
        "INSERT INTO invites (id, secret_hash, member_name, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        await sha256(secret),
        name,
        (existing?.role as string | undefined) ?? role,
        c.get("member").name,
        Date.now(),
        Date.now() + INVITE_LIFE,
      );
      return c.json({ id, secret, member: name, newMember: !existing, expiresAt: Date.now() + INVITE_LIFE }, 201);
    });

    app.get("/api/invites", adminOnly, async (c) => {
      const rows = this.#sql(
        "SELECT * FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
        Date.now(),
      );
      return c.json({
        invites: await Promise.all(
          rows.map(async (row) => ({
            id: row.id,
            member: row.member_name,
            role: row.role,
            expiresAt: row.expires_at,
            device: row.device_name ?? null,
            code:
              row.nonce && (row.asked_at as number) > Date.now() - CONFIRM_WINDOW
                ? await joinCode(row.secret_hash as string, row.nonce as string)
                : null,
          })),
        ),
      });
    });

    app.post("/api/invites/confirm", adminOnly, async (c) => {
      const { code } = await c.req.json<{ code?: unknown }>().catch(() => ({}) as { code?: unknown });
      for (const row of this.#sql(
        "SELECT * FROM invites WHERE used_at IS NULL AND expires_at > ? AND nonce IS NOT NULL AND asked_at > ?",
        Date.now(),
        Date.now() - CONFIRM_WINDOW,
      )) {
        if ((await joinCode(row.secret_hash as string, row.nonce as string)) !== String(code ?? "")) continue;
        let member = this.#one(
          "SELECT id FROM members WHERE name = ? AND removed_at IS NULL",
          row.member_name as string,
        );
        if (!member) {
          const id = randomId();
          this.#sql(
            "INSERT INTO members (id, name, role, created_at) VALUES (?, ?, ?, ?)",
            id,
            row.member_name as string,
            row.role as string,
            Date.now(),
          );
          member = { id };
        }
        this.#sql(
          "INSERT INTO devices (id, member_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
          randomId(),
          member.id as string,
          row.device_name as string,
          row.device_hash as string,
          Date.now(),
        );
        this.#sql("UPDATE invites SET used_at = ? WHERE id = ?", Date.now(), row.id as string);
        return c.json({ joined: row.member_name, device: row.device_name });
      }
      return problem(404, "no device waiting to join shows this code");
    });

    app.get("/api/members", (c) => {
      const members = this.#sql(
        "SELECT id, name, role, created_at FROM members WHERE removed_at IS NULL ORDER BY name",
      );
      const devices = this.#sql(
        "SELECT id, member_id, name, state, room, last_seen, state_at FROM devices WHERE revoked_at IS NULL ORDER BY name",
      );
      return c.json({
        members: members.map((member) => ({
          name: member.name,
          role: member.role,
          createdAt: member.created_at,
          devices: devices
            .filter((device) => device.member_id === member.id)
            .map((device) => ({
              id: device.id,
              name: device.name,
              state:
                (device.state_at as number | null) && (device.state_at as number) > Date.now() - SEEN
                  ? device.state
                  : "offline",
              lastSeen: device.last_seen,
            })),
        })),
      });
    });

    app.put("/api/members/:name/role", adminOnly, async (c) => {
      const { role } = await c.req.json<{ role?: unknown }>().catch(() => ({}) as { role?: unknown });
      if (role !== "admin" && role !== "member") return problem(400, "role takes admin or member");
      const member = this.#one(
        "SELECT id, role FROM members WHERE name = ? AND removed_at IS NULL",
        c.req.param("name"),
      );
      if (!member) return problem(404, `no member named ${c.req.param("name")}`);
      if (role === "member" && member.role === "admin" && this.#admins() <= 1) {
        return problem(409, "the team must keep at least one admin");
      }
      this.#sql("UPDATE members SET role = ? WHERE id = ?", role, member.id as string);
      return c.json({ name: c.req.param("name"), role });
    });

    app.delete("/api/members/:name", adminOnly, (c) => {
      const member = this.#one(
        "SELECT id, role FROM members WHERE name = ? AND removed_at IS NULL",
        c.req.param("name"),
      );
      if (!member) return problem(404, `no member named ${c.req.param("name")}`);
      if (member.role === "admin" && this.#admins() <= 1) return problem(409, "the team must keep at least one admin");
      this.#sql("UPDATE members SET removed_at = ? WHERE id = ?", Date.now(), member.id as string);
      this.#sql(
        "UPDATE devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL",
        Date.now(),
        member.id as string,
      );
      this.#closeSockets();
      return c.json({ removed: c.req.param("name") });
    });

    app.delete("/api/devices/:id", (c) => {
      const device = this.#one(
        "SELECT id, member_id FROM devices WHERE id = ? AND revoked_at IS NULL",
        c.req.param("id"),
      );
      if (!device) return problem(404, "no such device");
      if (device.member_id !== c.get("member").id && c.get("member").role !== "admin") {
        return problem(403, "only an admin can remove another member's device");
      }
      this.#sql("UPDATE devices SET revoked_at = ? WHERE id = ?", Date.now(), device.id as string);
      this.#closeSockets();
      return c.json({ removed: device.id });
    });

    app.post("/api/changes", async (c) => {
      const body = await c.req.json<{ changes?: Change[] }>().catch(() => ({}) as { changes?: Change[] });
      const changes = Array.isArray(body.changes) ? body.changes : [];
      if (changes.length > MAX_BATCH) return problem(400, `send at most ${MAX_BATCH} changes at once`);
      const applied: { id: string; recordId: string; version: number }[] = [];
      const refused: { id: string; reason: string }[] = [];
      const conflicts: { id: string; current: StoredRecord }[] = [];
      for (const change of changes) {
        if (typeof change?.id !== "string" || typeof change.recordId !== "string" || !Array.isArray(change.changed)) {
          refused.push({ id: String(change?.id ?? ""), reason: "a change needs id, recordId, changed and record" });
          continue;
        }
        const result = this.ctx.storage.transactionSync(() => this.#apply(change, c.get("member"), c.get("device")));
        if ("version" in result) applied.push({ id: change.id, recordId: change.recordId, version: result.version });
        else if ("refused" in result) refused.push({ id: change.id, reason: result.refused });
        else conflicts.push({ id: change.id, current: result.conflict });
      }
      if (applied.length > 0) {
        this.#notify();
        await schedule(this.#data);
      }
      return c.json({ applied, refused, conflicts });
    });

    app.get("/api/changes", (c) => {
      const after = Number(c.req.query("after") ?? 0);
      const limit = Math.min(Number(c.req.query("limit") ?? MAX_BATCH), MAX_BATCH);
      const tops = this.#topsOf(c.get("member"));
      const rows = this.#sql("SELECT * FROM records WHERE version > ? ORDER BY version LIMIT ?", after, limit);
      const last = rows.at(-1)?.version as number | undefined;
      return c.json({
        records: rows.map((row) => this.#record(row)).filter((record) => tops.includes(record.top)),
        next: last ?? Math.max(after, 0),
        version: this.#version(),
        tops: this.#sql("SELECT id, name, kind, repo_id FROM tops")
          .filter((top) => tops.includes(top.id as string))
          .map((top) => ({ id: top.id, name: top.name, kind: top.kind, repoId: top.repo_id })),
      });
    });

    app.get("/api/records/:id/history", (c) => {
      const record = this.#get(c.req.param("id"));
      if (!record || !this.#topsOf(c.get("member")).includes(record.top)) return problem(404, "no such record");
      return c.json({
        history: this.#sql(
          "SELECT version, author, device, ts, snapshot FROM history WHERE record_id = ? ORDER BY version",
          record.id,
        ).map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot as string) })),
      });
    });

    app.get("/api/records", (c) => {
      const tops = this.#topsOf(c.get("member"));
      const query = c.req.query("q")?.trim() ?? "";
      const type = c.req.query("type");
      const top = c.req.query("top");
      const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
      // Filtered before the LIMIT, so a type or top folder with older records still gets them.
      const where = [
        `r.top IN (${tops.map(() => "?").join(", ")})`,
        "r.retired_at IS NULL AND r.sealed IS NULL",
        "(? = '' OR r.type = ?) AND (? = '' OR r.top = ?)",
      ];
      const bindings = [...tops, type ?? "", type ?? "", top ?? "", top ?? ""];
      const rows = words.length
        ? this.#sql(
            `SELECT r.* FROM records_fts f JOIN records r ON r.id = f.id WHERE records_fts MATCH ? AND ${where.join(" AND ")} ORDER BY bm25(records_fts) LIMIT 200`,
            words.map((word) => `"${word}"`).join(" OR "),
            ...bindings,
          )
        : this.#sql(
            `SELECT r.* FROM records r WHERE ${where.join(" AND ")} ORDER BY r.updated_at DESC LIMIT 500`,
            ...bindings,
          );
      return c.json({ records: rows.map((row) => this.#record(row)) });
    });

    // The editor says every few seconds that it has a record open, and hears who else has.
    app.put("/api/records/:id/open", (c) => {
      const now = Date.now();
      const id = c.req.param("id");
      const editors = this.#open.get(id) ?? new Map();
      editors.set(c.get("device").id, { member: c.get("member").name, device: c.get("device").name, at: now });
      for (const [key, entry] of editors) if (entry.at < now - 60_000) editors.delete(key);
      this.#open.set(id, editors);
      return c.json({
        others: [...editors.entries()]
          .filter(([key]) => key !== c.get("device").id)
          .map(([, entry]) => ({ member: entry.member, device: entry.device })),
      });
    });

    app.put("/api/machines/me", async (c) => {
      const state = await c.req.json<MachineState>().catch(() => ({ state: "offline" }) as MachineState);
      this.#setState(c.get("device").id, state);
      return c.json({ ok: true });
    });

    app.get("/api/machines", (c) =>
      c.json({
        machines: this.#sql(
          `SELECT d.id, d.name, m.name AS member, d.state, d.state_at, d.last_seen, d.room FROM devices d
           JOIN members m ON m.id = d.member_id WHERE d.revoked_at IS NULL AND m.removed_at IS NULL ORDER BY d.name`,
        ).map((row) => ({
          id: row.id,
          name: row.name,
          member: row.member,
          state:
            (row.state_at as number | null) && (row.state_at as number) > Date.now() - SEEN ? row.state : "offline",
          lastSeen: row.last_seen,
          runs: this.#one(
            "SELECT count(*) AS n FROM runs WHERE device_id = ? AND started_at > ?",
            row.id as string,
            Date.now() - 30 * 86_400_000,
          )?.n,
        })),
      }),
    );

    app.put("/api/usage", async (c) => {
      const body = await c.req.json<{ rows?: UsageRow[] }>().catch(() => ({}) as { rows?: UsageRow[] });
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
      for (const row of rows) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.day))) continue;
        const count = (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
        this.#sql(
          `INSERT INTO usage (device_id, day, repo, requests, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost, routine_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, day, repo) DO UPDATE SET requests = excluded.requests,
           input_tokens = excluded.input_tokens, cache_write_tokens = excluded.cache_write_tokens,
           cache_read_tokens = excluded.cache_read_tokens, output_tokens = excluded.output_tokens, cost = excluded.cost,
           routine_minutes = excluded.routine_minutes`,
          c.get("device").id,
          String(row.day),
          String(row.repo ?? "").slice(0, 200),
          count(row.requests),
          count(row.inputTokens),
          count(row.cacheWriteTokens),
          count(row.cacheReadTokens),
          count(row.outputTokens),
          count(row.cost),
          count(row.routineMinutes),
        );
      }
      return c.json({ kept: rows.length });
    });

    /** Usage by person, machine, day and repo: a member's own, every machine's for an admin. */
    app.get("/api/usage", (c) => {
      const member = c.get("member");
      const since = c.req.query("since") ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const rows = this.#sql(
        `SELECT u.*, d.name AS machine, m.name AS member FROM usage u JOIN devices d ON d.id = u.device_id
         JOIN members m ON m.id = d.member_id WHERE u.day >= ? AND (? = 'admin' OR d.member_id = ?) ORDER BY u.day, m.name, d.name`,
        since,
        member.role,
        member.id,
      );
      return c.json({ usage: rows });
    });

    workRoutes(app, this.#data);

    return app;
  }

  #admins(): number {
    return Number(this.#one("SELECT count(*) AS n FROM members WHERE role = 'admin' AND removed_at IS NULL")?.n ?? 0);
  }

  /** Drops every live connection, so a removed device stops at once; the others reconnect. */
  #closeSockets(): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1012, "membership changed");
      } catch {
        // Already closing.
      }
    }
  }
}

export interface MachineState {
  state: "available" | "busy" | "away" | "offline";
  room: number;
  agents: string[];
}

interface UsageRow {
  day: string;
  repo: string;
  requests: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cost: number;
  routineMinutes: number;
}
