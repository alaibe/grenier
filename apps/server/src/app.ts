import { MAX_QUESTION, sha256, unshareable } from "@grenier/core/policy";
import { Hono } from "hono";
import type { TeamCounter } from "./counter.ts";
import { DASHBOARD } from "./dashboard.ts";

export interface Env {
  DB: D1Database;
  TEAM: DurableObjectNamespace<TeamCounter>;
  /** Each member's encrypted vault objects. The server never holds the key. */
  VAULT: R2Bucket;
}

const MAX_VAULT_OBJECT = 25 * 1024 * 1024;
const VAULT_NAME = /^[\w.-]{1,128}$/;

interface Member {
  id: string;
  name: string;
  role: "admin" | "member";
}

interface App {
  Bindings: Env;
  Variables: { member: Member };
}

const MAX_BATCH = 500;

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/** A new random token, and the hash the database keeps instead. */
export async function newToken(): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `gt_${btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
  return { token, hash: await sha256(token) };
}

function today(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function counter(env: Env) {
  return env.TEAM.get(env.TEAM.idFromName("team"));
}

interface SharedAnswer {
  id: string;
  repoId: string;
  question: string;
  answer: string;
  sources: { path: string; blobHash: string }[];
  createdAt: number;
}

interface SharedSummary {
  repoId: string;
  path: string;
  blobHash: string;
  summary: string;
  createdAt: number;
}

interface UsageDelta {
  day: string;
  requests: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cost: number;
  saved: number;
  answerHits: number;
}

interface UsageBody {
  usage?: UsageDelta[];
  device?: unknown;
  from?: unknown;
  through?: unknown;
}

function isString(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function createApp(): Hono<App> {
  const app = new Hono<App>();

  app.get("/", (c) => c.html(DASHBOARD));

  // Every API call needs a member's token; a revoked one fails on its next call.
  app.use("/api/*", async (c, next) => {
    const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const member = token
      ? await c.env.DB.prepare("SELECT id, name, role FROM members WHERE token_hash = ? AND revoked_at IS NULL")
          .bind(await sha256(token))
          .first<Member>()
      : null;
    if (!member) return error(401, "a valid member token is needed: Authorization: Bearer <token>");
    c.set("member", member);
    return next();
  });

  const adminOnly = async (c: { get: (key: "member") => Member }, next: () => Promise<void>) => {
    if (c.get("member").role !== "admin") return error(403, "only an admin can do this");
    return next();
  };

  app.get("/api/me", (c) => c.json(c.get("member")));

  /** A new token for the caller, who keeps their name, role and history; the one they called with stops working. */
  app.post("/api/me/rotate", async (c) => {
    const { token, hash } = await newToken();
    await c.env.DB.prepare("UPDATE members SET token_hash = ? WHERE id = ?").bind(hash, c.get("member").id).run();
    return c.json({ token });
  });

  app.post("/api/answers", async (c) => {
    const body = await c.req.json<{ answers?: SharedAnswer[] }>().catch(() => ({}) as { answers?: SharedAnswer[] });
    const answers = body.answers ?? [];
    if (!Array.isArray(answers) || answers.length > MAX_BATCH) return error(400, `send at most ${MAX_BATCH} answers`);
    const statements: D1PreparedStatement[] = [];
    for (const answer of answers) {
      const valid =
        isString(answer.id, 64) &&
        isString(answer.repoId, 128) &&
        isString(answer.question, MAX_QUESTION) &&
        typeof answer.answer === "string" &&
        isCount(answer.createdAt) &&
        Array.isArray(answer.sources) &&
        answer.sources.every((source) => isString(source.path, 1024) && isString(source.blobHash, 128));
      if (!valid) return error(400, "each answer needs id, repoId, question, answer, sources and createdAt");
      const asked = unshareable(answer.question);
      if (asked) return error(400, `the question of answer ${answer.id} is refused: ${asked}`);
      const problem = unshareable(answer.answer);
      if (problem) return error(400, `answer ${answer.id} is refused: ${problem}`);
      // The newest answer to a question replaces older ones, as it does on each machine: one recorded earlier but
      // sent late (a machine back online) changes nothing. A replaced answer stays as a tombstone, without its text.
      const newer =
        "NOT EXISTS (SELECT 1 FROM answers WHERE repo_id = ? AND lower(trim(question)) = lower(trim(?)) AND id != ? AND deleted = 0 AND created_at > ?)";
      const same = [answer.repoId, answer.question, answer.id, answer.createdAt] as const;
      statements.push(
        c.env.DB.prepare(
          `INSERT OR REPLACE INTO answers (id, repo_id, question, answer, sources, author, created_at, deleted) SELECT id, repo_id, question, '', sources, author, created_at, 1 FROM answers WHERE repo_id = ? AND lower(trim(question)) = lower(trim(?)) AND id != ? AND deleted = 0 AND ${newer}`,
        ).bind(answer.repoId, answer.question, answer.id, ...same),
        c.env.DB.prepare(
          `INSERT OR REPLACE INTO answers (id, repo_id, question, answer, sources, author, created_at, deleted) SELECT ?, ?, ?, ?, ?, ?, ?, 0 WHERE ${newer}`,
        ).bind(
          answer.id,
          answer.repoId,
          answer.question,
          answer.answer,
          JSON.stringify(answer.sources),
          c.get("member").name,
          answer.createdAt,
          ...same,
        ),
      );
    }
    if (statements.length > 0) await c.env.DB.batch(statements);
    return c.json({ accepted: answers.length });
  });

  /** Any member may forget an answer: it becomes a tombstone, without its text, that every machine pulls. */
  app.post("/api/answers/forget", async (c) => {
    const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length > MAX_BATCH || !ids.every((id) => isString(id, 64))) {
      return error(400, `send ids: at most ${MAX_BATCH} answer ids`);
    }
    const statements = ids.map((id) =>
      c.env.DB.prepare(
        "INSERT OR REPLACE INTO answers (id, repo_id, question, answer, sources, author, created_at, deleted) SELECT id, repo_id, question, '', sources, author, created_at, 1 FROM answers WHERE id = ? AND deleted = 0",
      ).bind(id),
    );
    if (statements.length > 0) await c.env.DB.batch(statements);
    return c.json({ forgotten: ids.length });
  });

  app.post("/api/summaries", async (c) => {
    const body = await c.req
      .json<{ summaries?: SharedSummary[] }>()
      .catch(() => ({}) as { summaries?: SharedSummary[] });
    const summaries = body.summaries ?? [];
    if (!Array.isArray(summaries) || summaries.length > MAX_BATCH)
      return error(400, `send at most ${MAX_BATCH} summaries`);
    const statements: D1PreparedStatement[] = [];
    for (const summary of summaries) {
      const valid =
        isString(summary.repoId, 128) &&
        isString(summary.path, 1024) &&
        isString(summary.blobHash, 128) &&
        typeof summary.summary === "string" &&
        isCount(summary.createdAt);
      if (!valid) return error(400, "each summary needs repoId, path, blobHash, summary and createdAt");
      const problem = unshareable(summary.summary);
      if (problem) return error(400, `the summary of ${summary.path} is refused: ${problem}`);
      statements.push(
        c.env.DB.prepare(
          "INSERT OR REPLACE INTO summaries (repo_id, path, blob_hash, summary, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(
          summary.repoId,
          summary.path,
          summary.blobHash,
          summary.summary,
          c.get("member").name,
          summary.createdAt,
        ),
      );
    }
    if (statements.length > 0) await c.env.DB.batch(statements);
    return c.json({ accepted: summaries.length });
  });

  /** What changed after the given seqs, for the listed repositories: answers (with tombstones) and summaries. */
  app.get("/api/sync", async (c) => {
    const repos = (c.req.query("repos") ?? "").split(",").filter(Boolean).slice(0, 100);
    const answersSince = Number(c.req.query("answers") ?? 0) || 0;
    const summariesSince = Number(c.req.query("summaries") ?? 0) || 0;
    if (repos.length === 0)
      return c.json({ answers: [], summaries: [], cursors: { answers: answersSince, summaries: summariesSince } });
    const marks = repos.map(() => "?").join(", ");
    const answers = await c.env.DB.prepare(
      `SELECT seq, id, repo_id AS repoId, question, answer, sources, author, created_at AS createdAt, deleted FROM answers WHERE seq > ? AND repo_id IN (${marks}) ORDER BY seq LIMIT ${MAX_BATCH}`,
    )
      .bind(answersSince, ...repos)
      .all<{ seq: number; sources: string; deleted: number }>();
    const summaries = await c.env.DB.prepare(
      `SELECT seq, repo_id AS repoId, path, blob_hash AS blobHash, summary, author, created_at AS createdAt FROM summaries WHERE seq > ? AND repo_id IN (${marks}) ORDER BY seq LIMIT ${MAX_BATCH}`,
    )
      .bind(summariesSince, ...repos)
      .all<{ seq: number }>();
    return c.json({
      answers: answers.results.map((row) => ({ ...row, sources: JSON.parse(row.sources), deleted: row.deleted === 1 })),
      summaries: summaries.results,
      cursors: {
        answers: answers.results.at(-1)?.seq ?? answersSince,
        summaries: summaries.results.at(-1)?.seq ?? summariesSince,
      },
    });
  });

  /**
   * Usage as daily numbers. A machine that names itself (`device`) says which of its usage rows the batch holds
   * (`from`, exclusive, to `through`): a batch that does not start where the last one ended is refused with 409 and
   * where it ended, so the same rows are never added twice. The first batch from a machine is taken as it comes.
   */
  app.post("/api/usage", async (c) => {
    const body = await c.req.json<UsageBody>().catch(() => ({}) as UsageBody);
    const deltas = body.usage ?? [];
    if (!Array.isArray(deltas) || deltas.length > MAX_BATCH) return error(400, `send at most ${MAX_BATCH} rows`);
    const member = c.get("member");
    const ranged = body.device !== undefined;
    if (
      ranged &&
      (!isString(body.device, 64) || !isCount(body.from) || !isCount(body.through) || body.through < body.from)
    ) {
      return error(400, "device takes a name, with from and through: the usage row ids the batch holds");
    }
    const device = String(body.device);
    // Inside the batch's transaction, so of two batches sent at once only the first is counted.
    const where = ranged
      ? "WHERE EXISTS (SELECT 1 FROM usage_cursors WHERE member_id = ? AND device = ? AND through = ?) OR NOT EXISTS (SELECT 1 FROM usage_cursors WHERE member_id = ? AND device = ?)"
      : "WHERE true";
    const guard = ranged ? [member.id, device, body.from, member.id, device] : [];
    const statements: D1PreparedStatement[] = [];
    for (const delta of deltas) {
      const numbers = [
        delta.requests,
        delta.inputTokens,
        delta.cacheWriteTokens,
        delta.cacheReadTokens,
        delta.outputTokens,
        delta.cost,
        delta.saved,
        delta.answerHits,
      ];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(delta.day)) || !numbers.every(isCount)) {
        return error(400, "each row needs a day and non-negative counts");
      }
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO usage (member_id, day, requests, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost, saved, answer_hits)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${where}
           ON CONFLICT (member_id, day) DO UPDATE SET
             requests = requests + excluded.requests, input_tokens = input_tokens + excluded.input_tokens,
             cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
             cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
             output_tokens = output_tokens + excluded.output_tokens, cost = cost + excluded.cost,
             saved = saved + excluded.saved, answer_hits = answer_hits + excluded.answer_hits`,
        ).bind(member.id, delta.day, ...numbers, ...guard),
      );
    }
    if (ranged) {
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO usage_cursors (member_id, device, through) VALUES (?, ?, ?) ON CONFLICT (member_id, device) DO UPDATE SET through = excluded.through WHERE usage_cursors.through = ?",
        ).bind(member.id, device, body.through, body.from),
      );
    }
    const results = statements.length > 0 ? await c.env.DB.batch(statements) : [];
    if (ranged && results.at(-1)?.meta.changes === 0) {
      const cursor = await c.env.DB.prepare("SELECT through FROM usage_cursors WHERE member_id = ? AND device = ?")
        .bind(member.id, device)
        .first<{ through: number }>();
      return Response.json(
        { error: `this machine's usage is counted through row ${cursor?.through}`, through: cursor?.through ?? 0 },
        { status: 409 },
      );
    }
    for (const delta of deltas) {
      if (delta.day === today() && delta.cost > 0) await counter(c.env).add(delta.day, member.id, delta.cost);
    }
    return c.json({ accepted: deltas.length });
  });

  /** Today's team and member limits with what was spent, for the proxy to check before forwarding. */
  app.get("/api/budget", async (c) => {
    const limits = await c.env.DB.prepare("SELECT scope, limit_amount AS limitAmount FROM budgets").all<{
      scope: string;
      limitAmount: number;
    }>();
    const spend = await counter(c.env).spent(today());
    const limit = (scope: string) => limits.results.find((row) => row.scope === scope)?.limitAmount ?? null;
    return c.json({
      day: today(),
      team: { limit: limit("team"), spent: spend.total },
      member: { limit: limit("member"), spent: spend.members[c.get("member").id] ?? 0 },
    });
  });

  app.put("/api/budget", adminOnly, async (c) => {
    const body = await c.req.json<{ team?: number | null; member?: number | null }>().catch(() => ({}));
    const statements: D1PreparedStatement[] = [];
    for (const scope of ["team", "member"] as const) {
      if (!(scope in body)) continue;
      const value = (body as Record<string, unknown>)[scope];
      if (value === null) statements.push(c.env.DB.prepare("DELETE FROM budgets WHERE scope = ?").bind(scope));
      else if (isCount(value)) {
        statements.push(
          c.env.DB.prepare("INSERT OR REPLACE INTO budgets (scope, limit_amount) VALUES (?, ?)").bind(scope, value),
        );
      } else return error(400, `${scope} takes an amount in dollars, or null`);
    }
    if (statements.length > 0) await c.env.DB.batch(statements);
    return c.json({ ok: true });
  });

  app.get("/api/members", adminOnly, async (c) => {
    const members = await c.env.DB.prepare(
      "SELECT name, role, created_at AS createdAt, revoked_at AS revokedAt FROM members ORDER BY name",
    ).all();
    return c.json({ members: members.results });
  });

  app.post("/api/members", adminOnly, async (c) => {
    const body = await c.req
      .json<{ name?: string; role?: string }>()
      .catch(() => ({}) as { name?: string; role?: string });
    if (!isString(body.name, 64) || !/^[\w.@-]+$/.test(body.name)) return error(400, "name: letters, digits, . _ @ -");
    const role = body.role === "admin" ? "admin" : "member";
    const existing = await c.env.DB.prepare("SELECT 1 FROM members WHERE name = ? AND revoked_at IS NULL")
      .bind(body.name)
      .first();
    if (existing) return error(409, `there is already a member named ${body.name}`);
    const { token, hash } = await newToken();
    // A revoked member keeps their history under a name of their own, so the name can be given again.
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE members SET name = name || '~' || revoked_at WHERE name = ? AND revoked_at IS NOT NULL",
      ).bind(body.name),
      c.env.DB.prepare("INSERT INTO members (id, name, token_hash, role, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        crypto.randomUUID(),
        body.name,
        hash,
        role,
        Date.now(),
      ),
    ]);
    return c.json({ name: body.name, role, token }, 201);
  });

  app.post("/api/members/:name/revoke", adminOnly, async (c) => {
    const name = c.req.param("name");
    if (name === c.get("member").name) return error(400, "an admin cannot revoke their own token");
    const result = await c.env.DB.prepare("UPDATE members SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL")
      .bind(Date.now(), name)
      .run();
    if (result.meta.changes === 0) return error(404, `no active member named ${name}`);
    return c.json({ revoked: name });
  });

  /** Usage per member and day for the last 30 days, with totals and members, for the dashboard. */
  app.get("/api/dashboard", adminOnly, async (c) => {
    const since = today(Date.now() - 29 * 86_400_000);
    const usage = await c.env.DB.prepare(
      `SELECT m.name AS member, u.day, u.requests, u.input_tokens AS inputTokens, u.cache_write_tokens AS cacheWriteTokens,
              u.cache_read_tokens AS cacheReadTokens, u.output_tokens AS outputTokens, u.cost, u.saved, u.answer_hits AS answerHits
       FROM usage u JOIN members m ON m.id = u.member_id WHERE u.day >= ? ORDER BY u.day DESC, m.name`,
    )
      .bind(since)
      .all();
    const members = await c.env.DB.prepare(
      "SELECT name, role, created_at AS createdAt, revoked_at AS revokedAt FROM members ORDER BY name",
    ).all();
    const answers = await c.env.DB.prepare("SELECT count(*) AS n FROM answers WHERE deleted = 0").first<{
      n: number;
    }>();
    const budget = await c.env.DB.prepare("SELECT scope, limit_amount AS limitAmount FROM budgets").all();
    return c.json({
      since,
      usage: usage.results,
      members: members.results,
      answers: answers?.n ?? 0,
      budgets: budget.results,
      today: await counter(c.env).spent(today()),
    });
  });

  // Vault objects are ciphertext made on the member's devices; they are stored and returned byte for byte.
  app.get("/api/vault", async (c) => {
    const prefix = `vault/${c.get("member").id}/`;
    const listed = await c.env.VAULT.list({ prefix });
    return c.json({
      objects: listed.objects.map((object) => ({
        name: object.key.slice(prefix.length),
        size: object.size,
        uploaded: object.uploaded.getTime(),
      })),
    });
  });

  app.put("/api/vault/:name", async (c) => {
    const name = c.req.param("name");
    if (!VAULT_NAME.test(name)) return error(400, "a vault object's name takes letters, digits and . _ -");
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_VAULT_OBJECT)
      return error(413, "a vault object holds 1 byte to 25 MB");
    await c.env.VAULT.put(`vault/${c.get("member").id}/${name}`, body);
    return c.json({ stored: name, size: body.byteLength });
  });

  app.get("/api/vault/:name", async (c) => {
    const name = c.req.param("name");
    if (!VAULT_NAME.test(name)) return error(400, "a vault object's name takes letters, digits and . _ -");
    const object = await c.env.VAULT.get(`vault/${c.get("member").id}/${name}`);
    if (!object) return error(404, `no vault object ${name}`);
    return new Response(object.body, { headers: { "content-type": "application/octet-stream" } });
  });

  app.notFound(() => error(404, "not found"));
  return app;
}
