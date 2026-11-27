import { bearer, DEVICE_NAME, MEMBER_NAME } from "@grenier/core";
import { sha256 } from "@grenier/core/policy";
import { joinCode } from "@grenier/core/records";
import { meTop, TEAM_PROTOCOL } from "@grenier/core/team";
import { and, asc, count, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { adminOnly, bodyAs, liveState, type Member, problem, randomId, type TeamApp, type TeamData } from "./data.ts";
import { devices, invites, members, weblinks } from "./db/schema.ts";

const INVITE_LIFE = 24 * 60 * 60 * 1000;
const CONFIRM_WINDOW = 10 * 60 * 1000;

function addDevice(team: TeamData, memberId: string, name: string, tokenHash: string): void {
  team.db.insert(devices).values({ id: randomId(), memberId, name, tokenHash, createdAt: Date.now() }).run();
}

function addMember(team: TeamData, name: string, role: Member["role"]): string {
  const id = randomId();
  team.db.insert(members).values({ id, name, role, createdAt: Date.now() }).run();
  return id;
}

const memberNamed = (team: TeamData, name: string) =>
  team.db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.name, name), isNull(members.removedAt)))
    .get();

const admins = (team: TeamData) =>
  team.db
    .select({ n: count() })
    .from(members)
    .where(and(eq(members.role, "admin"), isNull(members.removedAt)))
    .get()?.n ?? 0;

/** The routes a machine calls before it has a token: the first admin's setup, joining, and a browser's sign-in. */
const MEMBER_RULE = "a name takes letters, digits and . _ @ -";
const DEVICE_RULE = "a name takes letters, digits and . _ -";
const FirstAdmin = z.object({
  member: z
    .string("member takes letters, digits and . _ @ -, device letters, digits and . _ -")
    .regex(MEMBER_NAME, "member takes letters, digits and . _ @ -, device letters, digits and . _ -"),
  device: z
    .string("member takes letters, digits and . _ @ -, device letters, digits and . _ -")
    .regex(DEVICE_NAME, "member takes letters, digits and . _ @ -, device letters, digits and . _ -"),
});
const Join = z.object({
  invite: z.string().default(""),
  secret: z.string().optional(),
  device: z.string().default(""),
  tokenHash: z.string().default(""),
  nonce: z.string().default(""),
});
const Code = z.object({ code: z.coerce.string().default("") });
const Invite = z.object({
  name: z.string(MEMBER_RULE).regex(MEMBER_NAME, MEMBER_RULE),
  role: z.enum(["admin", "member"]).catch("member"),
});

export function entryRoutes(app: TeamApp, team: TeamData, setupHash: () => string | undefined): void {
  // Setting up the first admin, with the token the deploy made: once, while the team has no member.
  app.post("/api/setup", async (c) => {
    const token = bearer(c.req.header("authorization"));
    // Read at each request: a running instance outlives the deploy that set a new hash.
    const expected = setupHash();
    if (!token || !expected || (await sha256(token)) !== expected) {
      return problem(401, "setting up needs the token the deploy made");
    }
    if (team.db.select({ id: members.id }).from(members).limit(1).get()) {
      return problem(409, "this team is set up already");
    }
    const body = await bodyAs(c, FirstAdmin);
    if (body instanceof Response) return body;
    const { member: name, device: deviceName } = body;
    addDevice(team, addMember(team, name, "admin"), deviceName, await sha256(token));
    return c.json({ member: name, role: "admin" }, 201);
  });

  // Joining: the device sends the hash of the token it made; it works once an admin confirms the code.
  app.post("/api/join", async (c) => {
    const body = await bodyAs(c, Join);
    if (body instanceof Response) return body;
    const invite = team.db.select().from(invites).where(eq(invites.id, body.invite)).get();
    const secretHash = body.secret === undefined ? "" : await sha256(body.secret);
    if (!invite || invite.secretHash !== secretHash || invite.usedAt !== null || invite.expiresAt < Date.now()) {
      return problem(404, "this invite link is not valid: it was used, it expired, or it was made for another team");
    }
    const { device, tokenHash, nonce } = body;
    if (!DEVICE_NAME.test(device) || !/^[0-9a-f]{64}$/.test(tokenHash) || !/^[0-9a-f]{16,64}$/.test(nonce)) {
      return problem(400, "device takes letters, digits and . _ -; tokenHash and nonce are hex");
    }
    team.db
      .update(invites)
      .set({ deviceName: device, deviceHash: tokenHash, nonce, askedAt: Date.now() })
      .where(eq(invites.id, invite.id))
      .run();
    return c.json({ waiting: true, member: invite.memberName }, 202);
  });

  // Signing in a browser: a one-time code a device made becomes a token for a device named web.
  app.post("/web/login", async (c) => {
    const body = await bodyAs(c, Code);
    if (body instanceof Response) return body;
    const codeHash = await sha256(body.code);
    const link = team.db
      .select()
      .from(weblinks)
      .where(and(eq(weblinks.codeHash, codeHash), isNull(weblinks.usedAt), gt(weblinks.expiresAt, Date.now())))
      .get();
    if (!link) return problem(404, "this sign-in link was used or expired: make another on the app's Team screen");
    const token = `gt_${randomId(32)}`;
    team.db.update(weblinks).set({ usedAt: Date.now() }).where(eq(weblinks.codeHash, link.codeHash)).run();
    addDevice(team, link.memberId, "web", await sha256(token));
    return c.json({ token });
  });
}

/** Who is in the team: this machine's member, invites, members and their roles, and their machines. */
export function memberRoutes(app: TeamApp, team: TeamData): void {
  app.post("/api/weblinks", async (c) => {
    const code = randomId(16);
    const codeHash = await sha256(code);
    team.db
      .insert(weblinks)
      .values({ codeHash, memberId: c.get("member").id, expiresAt: Date.now() + CONFIRM_WINDOW })
      .run();
    return c.json({ path: `/#login=${code}` }, 201);
  });

  app.get("/api/me", (c) =>
    c.json({
      ...c.get("member"),
      device: c.get("device").name,
      deviceId: c.get("device").id,
      version: team.version(),
      protocol: TEAM_PROTOCOL,
      me: meTop(c.get("member").id),
    }),
  );

  app.put("/api/me/device", async (c) => {
    const body = await bodyAs(c, z.object({ name: z.string().regex(DEVICE_NAME, DEVICE_RULE) }));
    if (body instanceof Response) return body;
    const { name } = body;
    team.db
      .update(devices)
      .set({ name })
      .where(eq(devices.id, c.get("device").id))
      .run();
    return c.json({ name });
  });

  app.post("/api/invites", adminOnly, async (c) => {
    const body = await bodyAs(c, Invite);
    if (body instanceof Response) return body;
    const { name, role } = body;
    const existing = memberNamed(team, name);
    const id = randomId(8);
    const secret = randomId(16);
    const expiresAt = Date.now() + INVITE_LIFE;
    const secretHash = await sha256(secret);
    team.db
      .insert(invites)
      .values({
        id,
        secretHash,
        memberName: name,
        role: existing?.role ?? role,
        createdBy: c.get("member").name,
        createdAt: Date.now(),
        expiresAt,
      })
      .run();
    return c.json({ id, secret, member: name, newMember: !existing, expiresAt }, 201);
  });

  app.get("/api/invites", adminOnly, async (c) => {
    const rows = team.db
      .select()
      .from(invites)
      .where(and(isNull(invites.usedAt), gt(invites.expiresAt, Date.now())))
      .orderBy(desc(invites.createdAt))
      .all();
    return c.json({
      invites: await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          member: row.memberName,
          role: row.role,
          expiresAt: row.expiresAt,
          device: row.deviceName ?? null,
          code:
            row.nonce && (row.askedAt ?? 0) > Date.now() - CONFIRM_WINDOW
              ? await joinCode(row.secretHash, row.nonce)
              : null,
        })),
      ),
    });
  });

  app.post("/api/invites/confirm", adminOnly, async (c) => {
    const body = await bodyAs(c, Code);
    if (body instanceof Response) return body;
    const waiting = team.db
      .select()
      .from(invites)
      .where(
        and(
          isNull(invites.usedAt),
          gt(invites.expiresAt, Date.now()),
          isNotNull(invites.nonce),
          gt(invites.askedAt, Date.now() - CONFIRM_WINDOW),
        ),
      )
      .all();
    for (const row of waiting) {
      if ((await joinCode(row.secretHash, row.nonce as string)) !== body.code) continue;
      const name = row.memberName;
      const memberId = memberNamed(team, name)?.id ?? addMember(team, name, row.role);
      addDevice(team, memberId, row.deviceName as string, row.deviceHash as string);
      team.db.update(invites).set({ usedAt: Date.now() }).where(eq(invites.id, row.id)).run();
      return c.json({ joined: row.memberName, device: row.deviceName });
    }
    return problem(404, "no device waiting to join shows this code");
  });

  app.get("/api/members", (c) => {
    const people = team.db
      .select({ id: members.id, name: members.name, role: members.role, createdAt: members.createdAt })
      .from(members)
      .where(isNull(members.removedAt))
      .orderBy(asc(members.name))
      .all();
    const machines = team.db
      .select({
        id: devices.id,
        memberId: devices.memberId,
        name: devices.name,
        state: devices.state,
        lastSeen: devices.lastSeen,
        stateAt: devices.stateAt,
      })
      .from(devices)
      .where(isNull(devices.revokedAt))
      .orderBy(asc(devices.name))
      .all();
    return c.json({
      members: people.map((member) => ({
        name: member.name,
        role: member.role,
        createdAt: member.createdAt,
        devices: machines
          .filter((device) => device.memberId === member.id)
          .map((device) => ({
            id: device.id,
            name: device.name,
            state: liveState(device),
            lastSeen: device.lastSeen,
          })),
      })),
    });
  });

  app.put("/api/members/:name/role", adminOnly, async (c) => {
    const body = await bodyAs(c, z.object({ role: z.enum(["admin", "member"], "role takes admin or member") }));
    if (body instanceof Response) return body;
    const { role } = body;
    const member = memberNamed(team, c.req.param("name"));
    if (!member) return problem(404, `no member named ${c.req.param("name")}`);
    if (role === "member" && member.role === "admin" && admins(team) <= 1) {
      return problem(409, "the team must keep at least one admin");
    }
    team.db.update(members).set({ role }).where(eq(members.id, member.id)).run();
    return c.json({ name: c.req.param("name"), role });
  });

  app.delete("/api/members/:name", adminOnly, (c) => {
    const member = memberNamed(team, c.req.param("name"));
    if (!member) return problem(404, `no member named ${c.req.param("name")}`);
    if (member.role === "admin" && admins(team) <= 1) return problem(409, "the team must keep at least one admin");
    team.db.update(members).set({ removedAt: Date.now() }).where(eq(members.id, member.id)).run();
    team.db
      .update(devices)
      .set({ revokedAt: Date.now() })
      .where(and(eq(devices.memberId, member.id), isNull(devices.revokedAt)))
      .run();
    team.closeSockets();
    return c.json({ removed: c.req.param("name") });
  });

  app.delete("/api/devices/:id", (c) => {
    const device = team.db
      .select({ id: devices.id, memberId: devices.memberId })
      .from(devices)
      .where(and(eq(devices.id, c.req.param("id")), isNull(devices.revokedAt)))
      .get();
    if (!device) return problem(404, "no such device");
    if (device.memberId !== c.get("member").id && c.get("member").role !== "admin") {
      return problem(403, "only an admin can remove another member's device");
    }
    team.db.update(devices).set({ revokedAt: Date.now() }).where(eq(devices.id, device.id)).run();
    team.closeSockets();
    return c.json({ removed: device.id });
  });
}
