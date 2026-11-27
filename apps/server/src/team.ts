import { DurableObject } from "cloudflare:workers";
import { bearer } from "@grenier/core";
import { sha256 } from "@grenier/core/policy";
import { meTop } from "@grenier/core/team";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { Hono } from "hono";
import migrations from "../drizzle/migrations.js";
import { type Device, type Member, problem, type TeamApp, type TeamData, type Vars } from "./data.ts";
import * as schema from "./db/schema.ts";
import { counter, devices, members } from "./db/schema.ts";
import { type MachineState, machineRoutes, setState } from "./machines.ts";
import { mcpRoutes } from "./mcp.ts";
import { entryRoutes, memberRoutes } from "./members.ts";
import { getRecord, putRecord, recordRoutes } from "./records.ts";
import { fileDue, workRoutes } from "./work.ts";

export interface Env {
  TEAM: DurableObjectNamespace<TeamStore>;
  /** The SHA-256 of the token the deploy made, which sets up the first admin, once. */
  SETUP_HASH?: string;
}

/** One team's store; being one Durable Object, it puts every change in order. */
export class TeamStore extends DurableObject<Env> {
  #app: TeamApp;
  #data: TeamData = {
    storage: this.ctx.storage,
    db: drizzle(this.ctx.storage, { schema }),
    get: (id) => getRecord(this.#data, id),
    put: (record, author, device) => putRecord(this.#data, record, author, device),
    version: () => this.#version(),
    nextVersion: () => this.#nextVersion(),
    topsOf: (member) => ["team", meTop(member.id)],
    authenticate: (request) => this.#authenticate(request),
    notify: () => this.#notify(),
    closeSockets: () => this.#closeSockets(),
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      // A store from before drizzle's migrations starts empty: the team pushes its pages again.
      if (this.#data.db.get(sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)) {
        await ctx.storage.deleteAll();
      }
      await migrate(this.#data.db, migrations);
    });
    this.#app = this.#routes();
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
      if (data.type === "state") setState(this.#data, deviceId, data as unknown as MachineState);
    } catch {
      // A malformed message changes nothing.
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    const [deviceId] = this.ctx.getTags(socket);
    if (deviceId && this.ctx.getWebSockets(deviceId).length === 0) {
      this.#data.db
        .update(devices)
        .set({ state: "offline", stateAt: Date.now() })
        .where(eq(devices.id, deviceId))
        .run();
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

  #closeSockets(): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1012, "membership changed");
      } catch {
        // Already closing.
      }
    }
  }

  async #authenticate(request: Request): Promise<{ member: Member; device: Device } | null> {
    const token = bearer(request.headers.get("authorization"));
    if (!token) return null;
    const tokenHash = await sha256(token);
    const { db } = this.#data;
    const row = db
      .select({
        id: devices.id,
        name: devices.name,
        memberId: devices.memberId,
        memberName: members.name,
        role: members.role,
      })
      .from(devices)
      .innerJoin(members, eq(members.id, devices.memberId))
      .where(and(eq(devices.tokenHash, tokenHash), isNull(devices.revokedAt), isNull(members.removedAt)))
      .get();
    if (!row) return null;
    db.update(devices).set({ lastSeen: Date.now() }).where(eq(devices.id, row.id)).run();
    return {
      member: { id: row.memberId, name: row.memberName, role: row.role },
      device: { id: row.id, name: row.name, memberId: row.memberId },
    };
  }

  #version(): number {
    return this.#data.db.select({ version: counter.version }).from(counter).get()?.version ?? 0;
  }

  #nextVersion(): number {
    return this.#data.db
      .insert(counter)
      .values({ id: 1, version: 1 })
      .onConflictDoUpdate({ target: counter.id, set: { version: sql`${counter.version} + 1` } })
      .returning({ version: counter.version })
      .get().version;
  }

  /** Files the task of each scheduled routine that is due, unless the last one it filed is still waiting. */
  override async alarm(): Promise<void> {
    await fileDue(this.#data);
  }

  #routes(): TeamApp {
    const app = new Hono<{ Variables: Vars }>();
    app.onError((error) => problem(500, error.message));
    entryRoutes(app, this.#data, () => this.env.SETUP_HASH);
    mcpRoutes(app, this.#data);

    // Every other route needs a device's token; a revoked one fails on its next call.
    app.use("/api/*", async (c, next) => {
      const who = await this.#authenticate(c.req.raw);
      if (!who) return problem(401, "a valid device token is needed: Authorization: Bearer <token>");
      c.set("member", who.member);
      c.set("device", who.device);
      return next();
    });

    memberRoutes(app, this.#data);
    recordRoutes(app, this.#data);
    machineRoutes(app, this.#data);
    workRoutes(app, this.#data);
    return app;
  }
}
