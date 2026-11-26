import { bearer, DEVICE_NAME, MEMBER_NAME } from "@grenier/core";
import { sha256 } from "@grenier/core/policy";
import { joinCode } from "@grenier/core/records";
import { meTop, TEAM_PROTOCOL } from "@grenier/core/team";
import { adminOnly, jsonBody, liveState, problem, type Row, randomId, type TeamApp, type TeamData } from "./data.ts";

const INVITE_LIFE = 24 * 60 * 60 * 1000;
const CONFIRM_WINDOW = 10 * 60 * 1000;

function addDevice(team: TeamData, memberId: string, name: string, tokenHash: string): void {
  team.sql(
    "INSERT INTO devices (id, member_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    randomId(),
    memberId,
    name,
    tokenHash,
    Date.now(),
  );
}

function addMember(team: TeamData, name: string, role: string): string {
  const id = randomId();
  team.sql("INSERT INTO members (id, name, role, created_at) VALUES (?, ?, ?, ?)", id, name, role, Date.now());
  return id;
}

const memberNamed = (team: TeamData, name: string): Row | undefined =>
  team.one("SELECT id, role FROM members WHERE name = ? AND removed_at IS NULL", name);

const admins = (team: TeamData) =>
  Number(team.one("SELECT count(*) AS n FROM members WHERE role = 'admin' AND removed_at IS NULL")?.n ?? 0);

/** The routes a machine calls before it has a token: the first admin's setup, joining, and a browser's sign-in. */
export function entryRoutes(app: TeamApp, team: TeamData, setupHash: string | undefined): void {
  // Setting up the first admin, with the token the deploy made: once, while the team has no member.
  app.post("/api/setup", async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (!token || !setupHash || (await sha256(token)) !== setupHash) {
      return problem(401, "setting up needs the token the deploy made");
    }
    if (team.one("SELECT id FROM members LIMIT 1")) return problem(409, "this team is set up already");
    const body = await jsonBody(c);
    const name = String(body.member ?? "");
    const deviceName = String(body.device ?? "");
    if (!MEMBER_NAME.test(name) || !DEVICE_NAME.test(deviceName)) {
      return problem(400, "member takes letters, digits and . _ @ -, device letters, digits and . _ -");
    }
    addDevice(team, addMember(team, name, "admin"), deviceName, await sha256(token));
    return c.json({ member: name, role: "admin" }, 201);
  });

  // Joining: the device sends the hash of the token it made; it works once an admin confirms the code.
  app.post("/api/join", async (c) => {
    const body = await jsonBody(c);
    const invite = team.one("SELECT * FROM invites WHERE id = ?", String(body.invite ?? ""));
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
    if (!DEVICE_NAME.test(device) || !/^[0-9a-f]{64}$/.test(tokenHash) || !/^[0-9a-f]{16,64}$/.test(nonce)) {
      return problem(400, "device takes letters, digits and . _ -; tokenHash and nonce are hex");
    }
    team.sql(
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
    const { code } = await jsonBody<{ code?: unknown }>(c);
    const link = team.one(
      "SELECT * FROM weblinks WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
      await sha256(String(code ?? "")),
      Date.now(),
    );
    if (!link) return problem(404, "this sign-in link was used or expired: make another on the app's Team screen");
    const token = `gt_${randomId(32)}`;
    team.sql("UPDATE weblinks SET used_at = ? WHERE code_hash = ?", Date.now(), link.code_hash as string);
    addDevice(team, link.member_id as string, "web", await sha256(token));
    return c.json({ token });
  });
}

/** Who is in the team: this machine's member, invites, members and their roles, and their machines. */
export function memberRoutes(app: TeamApp, team: TeamData): void {
  app.post("/api/weblinks", async (c) => {
    const code = randomId(16);
    team.sql(
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
      version: team.version(),
      protocol: TEAM_PROTOCOL,
      me: meTop(c.get("member").id),
    }),
  );

  app.put("/api/me/device", async (c) => {
    const { name } = await jsonBody<{ name?: unknown }>(c);
    if (typeof name !== "string" || !DEVICE_NAME.test(name))
      return problem(400, "a name takes letters, digits and . _ -");
    team.sql("UPDATE devices SET name = ? WHERE id = ?", name, c.get("device").id);
    return c.json({ name });
  });

  app.post("/api/invites", adminOnly, async (c) => {
    const body = await jsonBody(c);
    const name = String(body.name ?? "");
    const role = body.role === "admin" ? "admin" : "member";
    if (!MEMBER_NAME.test(name)) return problem(400, "a name takes letters, digits and . _ @ -");
    const existing = memberNamed(team, name);
    const id = randomId(8);
    const secret = randomId(16);
    const expiresAt = Date.now() + INVITE_LIFE;
    team.sql(
      "INSERT INTO invites (id, secret_hash, member_name, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      await sha256(secret),
      name,
      (existing?.role as string | undefined) ?? role,
      c.get("member").name,
      Date.now(),
      expiresAt,
    );
    return c.json({ id, secret, member: name, newMember: !existing, expiresAt }, 201);
  });

  app.get("/api/invites", adminOnly, async (c) => {
    const rows = team.sql(
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
    const { code } = await jsonBody<{ code?: unknown }>(c);
    for (const row of team.sql(
      "SELECT * FROM invites WHERE used_at IS NULL AND expires_at > ? AND nonce IS NOT NULL AND asked_at > ?",
      Date.now(),
      Date.now() - CONFIRM_WINDOW,
    )) {
      if ((await joinCode(row.secret_hash as string, row.nonce as string)) !== String(code ?? "")) continue;
      const name = row.member_name as string;
      const memberId = (memberNamed(team, name)?.id as string | undefined) ?? addMember(team, name, row.role as string);
      addDevice(team, memberId, row.device_name as string, row.device_hash as string);
      team.sql("UPDATE invites SET used_at = ? WHERE id = ?", Date.now(), row.id as string);
      return c.json({ joined: row.member_name, device: row.device_name });
    }
    return problem(404, "no device waiting to join shows this code");
  });

  app.get("/api/members", (c) => {
    const members = team.sql("SELECT id, name, role, created_at FROM members WHERE removed_at IS NULL ORDER BY name");
    const devices = team.sql(
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
            state: liveState(device),
            lastSeen: device.last_seen,
          })),
      })),
    });
  });

  app.put("/api/members/:name/role", adminOnly, async (c) => {
    const { role } = await jsonBody<{ role?: unknown }>(c);
    if (role !== "admin" && role !== "member") return problem(400, "role takes admin or member");
    const member = memberNamed(team, c.req.param("name"));
    if (!member) return problem(404, `no member named ${c.req.param("name")}`);
    if (role === "member" && member.role === "admin" && admins(team) <= 1) {
      return problem(409, "the team must keep at least one admin");
    }
    team.sql("UPDATE members SET role = ? WHERE id = ?", role, member.id as string);
    return c.json({ name: c.req.param("name"), role });
  });

  app.delete("/api/members/:name", adminOnly, (c) => {
    const member = memberNamed(team, c.req.param("name"));
    if (!member) return problem(404, `no member named ${c.req.param("name")}`);
    if (member.role === "admin" && admins(team) <= 1) return problem(409, "the team must keep at least one admin");
    team.sql("UPDATE members SET removed_at = ? WHERE id = ?", Date.now(), member.id as string);
    team.sql(
      "UPDATE devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL",
      Date.now(),
      member.id as string,
    );
    team.closeSockets();
    return c.json({ removed: c.req.param("name") });
  });

  app.delete("/api/devices/:id", (c) => {
    const device = team.one("SELECT id, member_id FROM devices WHERE id = ? AND revoked_at IS NULL", c.req.param("id"));
    if (!device) return problem(404, "no such device");
    if (device.member_id !== c.get("member").id && c.get("member").role !== "admin") {
      return problem(403, "only an admin can remove another member's device");
    }
    team.sql("UPDATE devices SET revoked_at = ? WHERE id = ?", Date.now(), device.id as string);
    team.closeSockets();
    return c.json({ removed: device.id });
  });
}
