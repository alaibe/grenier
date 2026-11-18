import type { Store, Usage } from "@grenier/store";
import type { Embedder } from "./embeddings.ts";

export interface TeamClient {
  url: string;
  token: string;
  fetch?: typeof fetch;
}

export class TeamError extends Error {
  override name = "TeamError";
  constructor(
    message: string,
    readonly status: number,
    /** The server's own message. */
    readonly reason = message,
  ) {
    super(message);
  }
}

/** One call to the team server's API. Throws TeamError with the server's message. */
export async function teamApi<T>(
  team: TeamClient,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await (team.fetch ?? fetch)(new URL(path, team.url), {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${team.token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const message = (body as { error?: string } | undefined)?.error ?? `HTTP ${response.status}`;
    throw new TeamError(`the team server answered: ${message}`, response.status, message);
  }
  return body as T;
}

export interface TeamBudget {
  day: string;
  team: { limit: number | null; spent: number };
  member: { limit: number | null; spent: number };
}

export interface SyncDeps {
  store: Store;
  embedder: Embedder | null;
  team: TeamClient;
  /** What prompt-cache reads saved on this request, in USD. */
  savedOf: (row: Usage) => number;
  /** `[cache] share_with_team`: every repository with something in the cache, not only those shared one by one. */
  shareAll: boolean;
}

export interface SyncResult {
  pushed: { answers: number; summaries: number; usageRows: number; forgotten: number };
  pulled: { answers: number; removed: number; summaries: number };
  /** What the team server refused: it stays on this machine, with the reason, and is not sent again. */
  refused: { answers: number; summaries: number };
}

const BATCH = 200;
const FORGOTTEN = "forgotten_answers";

/**
 * Removes an answer from this machine's cache. One that is on the team server is forgotten there too, at the next
 * sync: `shared` says so. Null when there is no such answer.
 */
export async function forgetAnswer(store: Store, id: string): Promise<{ shared: boolean } | null> {
  const answer = await store.answers.get(id);
  if (!answer) return null;
  await store.answers.remove(id);
  if (answer.shared) {
    const pending = JSON.parse((await store.team.get(FORGOTTEN)) ?? "[]") as string[];
    if (!pending.includes(id)) await store.team.set(FORGOTTEN, JSON.stringify([...pending, id]));
  }
  return { shared: answer.shared };
}

const refusal = (error: unknown) => error instanceof TeamError && error.status === 400;

/**
 * Sends rows in one call. When the server refuses the call, sends them one at a time and sets aside each one it
 * refuses, so a single row it will never take does not hold back the others. Returns the rows it took.
 */
async function pushRows<T>(
  team: TeamClient,
  path: string,
  rows: readonly T[],
  body: (rows: readonly T[]) => object,
  refuse: (row: T, reason: string) => Promise<void>,
): Promise<{ accepted: T[]; refused: number }> {
  if (rows.length > 1) {
    try {
      await teamApi(team, path, { body: body(rows) });
      return { accepted: [...rows], refused: 0 };
    } catch (error) {
      if (!refusal(error)) throw error;
    }
  }
  const accepted: T[] = [];
  let refused = 0;
  for (const row of rows) {
    try {
      await teamApi(team, path, { body: body([row]) });
      accepted.push(row);
    } catch (error) {
      if (!refusal(error)) throw error;
      await refuse(row, (error as TeamError).reason);
      refused += 1;
    }
  }
  return { accepted, refused };
}

interface RemoteAnswer {
  seq: number;
  id: string;
  repoId: string;
  question: string;
  answer: string;
  sources: { path: string; blobHash: string }[];
  author: string;
  createdAt: number;
  deleted: boolean;
}

interface RemoteSummary {
  seq: number;
  repoId: string;
  path: string;
  blobHash: string;
  summary: string;
  author: string;
  createdAt: number;
}

async function sharedRepos(deps: SyncDeps): Promise<string[]> {
  const ids = new Set((await deps.store.team.repos()).map((repo) => repo.repoId));
  if (deps.shareAll) {
    for (const row of await deps.store.answers.stats()) ids.add(row.repoId);
    for (const row of await deps.store.summaries.stats()) ids.add(row.repoId);
  }
  return [...ids].sort();
}

/** UTC day of a Unix time in milliseconds: the team server's days. */
function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * One round of team sync: push what this machine recorded for the shared repositories (answers, summaries, usage
 * numbers), then pull what others recorded. The local cache stays the source of truth: when the server cannot be
 * reached this throws, and nothing local changes.
 */
export async function syncOnce(deps: SyncDeps): Promise<SyncResult> {
  const { store, team } = deps;
  const result: SyncResult = {
    pushed: { answers: 0, summaries: 0, usageRows: 0, forgotten: 0 },
    pulled: { answers: 0, removed: 0, summaries: 0 },
    refused: { answers: 0, summaries: 0 },
  };
  const repos = await sharedRepos(deps);

  const forgotten = JSON.parse((await store.team.get(FORGOTTEN)) ?? "[]") as string[];
  const sent: string[] = [];
  for (let at = 0; at < forgotten.length; at += BATCH) {
    const ids = forgotten.slice(at, at + BATCH);
    try {
      await teamApi(team, "/api/answers/forget", { body: { ids } });
      sent.push(...ids);
    } catch (error) {
      // A team server deployed before forgetting existed: the ids wait for `grenier team deploy`.
      if (!(error instanceof TeamError && error.status === 404)) throw error;
      break;
    }
  }
  if (sent.length > 0) {
    const pending = JSON.parse((await store.team.get(FORGOTTEN)) ?? "[]") as string[];
    await store.team.set(FORGOTTEN, JSON.stringify(pending.filter((id) => !sent.includes(id))));
    result.pushed.forgotten = sent.length;
  }

  for (;;) {
    const batch = await store.answers.unshared(repos, BATCH);
    if (batch.length === 0) break;
    const { accepted, refused } = await pushRows(
      team,
      "/api/answers",
      batch,
      (rows) => ({
        answers: rows.map((answer) => ({
          id: answer.id,
          repoId: answer.repoId,
          question: answer.question,
          answer: answer.answer,
          sources: answer.sources,
          createdAt: answer.createdAt,
        })),
      }),
      (answer, reason) => store.answers.refuse(answer.id, reason),
    );
    await store.answers.markShared(accepted.map((answer) => answer.id));
    result.pushed.answers += accepted.length;
    result.refused.answers += refused;
  }

  for (;;) {
    const batch = await store.summaries.unshared(repos, BATCH);
    if (batch.length === 0) break;
    const { accepted, refused } = await pushRows(
      team,
      "/api/summaries",
      batch,
      (rows) => ({
        summaries: rows.map(({ repoId, path, blobHash, summary, createdAt }) => ({
          repoId,
          path,
          blobHash,
          summary,
          createdAt,
        })),
      }),
      (summary, reason) => store.summaries.refuse(summary, reason),
    );
    await store.summaries.markShared(accepted);
    result.pushed.summaries += accepted.length;
    result.refused.summaries += refused;
  }

  if (repos.length > 0) {
    for (;;) {
      const answersSince = Number((await store.team.get("answers_seq")) ?? 0);
      const summariesSince = Number((await store.team.get("summaries_seq")) ?? 0);
      const query = new URLSearchParams({
        repos: repos.join(","),
        answers: String(answersSince),
        summaries: String(summariesSince),
      });
      const changes = await teamApi<{
        answers: RemoteAnswer[];
        summaries: RemoteSummary[];
        cursors: { answers: number; summaries: number };
      }>(team, `/api/sync?${query}`);

      for (const remote of changes.answers) {
        if (remote.deleted) {
          await store.answers.remove(remote.id);
          result.pulled.removed += 1;
          continue;
        }
        if (await store.answers.get(remote.id)) continue;
        const [vector] = deps.embedder ? await deps.embedder.embed([remote.question]) : [];
        await store.answers.add(
          {
            id: remote.id,
            repoId: remote.repoId,
            question: remote.question,
            answer: remote.answer,
            createdAt: remote.createdAt,
            author: remote.author,
            shared: true,
          },
          remote.sources,
          vector && deps.embedder ? { model: deps.embedder.model, vector } : undefined,
        );
        result.pulled.answers += 1;
      }
      for (const remote of changes.summaries) {
        await store.summaries.put({
          repoId: remote.repoId,
          path: remote.path,
          blobHash: remote.blobHash,
          summary: remote.summary,
          createdAt: remote.createdAt,
          shared: true,
        });
        result.pulled.summaries += 1;
      }
      await store.team.set("answers_seq", String(changes.cursors.answers));
      await store.team.set("summaries_seq", String(changes.cursors.summaries));
      if (changes.answers.length === 0 && changes.summaries.length === 0) break;
    }
  }

  const usageCursor = Number((await store.team.get("usage_id")) ?? 0);
  const rows = await store.usage.after(usageCursor, 1000);
  const hits = await store.answers.totalHits();
  const hitsPushed = Number((await store.team.get("hits_pushed")) ?? hits);
  const days = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const day = utcDay(row.ts);
    const delta = days.get(day) ?? {
      requests: 0,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cost: 0,
      saved: 0,
      answerHits: 0,
    };
    delta.requests = (delta.requests ?? 0) + 1;
    delta.inputTokens = (delta.inputTokens ?? 0) + (row.inputTokens ?? 0);
    delta.cacheWriteTokens = (delta.cacheWriteTokens ?? 0) + (row.cacheWriteTokens ?? 0);
    delta.cacheReadTokens = (delta.cacheReadTokens ?? 0) + (row.cacheReadTokens ?? 0);
    delta.outputTokens = (delta.outputTokens ?? 0) + (row.outputTokens ?? 0);
    delta.cost = (delta.cost ?? 0) + (row.cost ?? 0);
    delta.saved = (delta.saved ?? 0) + deps.savedOf(row);
    days.set(day, delta);
  }
  const newHits = Math.max(0, hits - hitsPushed);
  if (newHits > 0) {
    const today = utcDay(Date.now());
    const delta = days.get(today) ?? {
      requests: 0,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cost: 0,
      saved: 0,
      answerHits: 0,
    };
    delta.answerHits = newHits;
    days.set(today, delta);
  }
  if (days.size > 0) {
    await teamApi(team, "/api/usage", {
      body: { usage: [...days.entries()].map(([day, delta]) => ({ day, ...delta })) },
    });
    result.pushed.usageRows = rows.length;
  }
  const last = rows.at(-1);
  if (last) await store.team.set("usage_id", String(last.id));
  await store.team.set("hits_pushed", String(hits));
  return result;
}
