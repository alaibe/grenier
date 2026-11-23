import { open, seal, VaultError } from "@grenier/core";
import type { FullRecord, OutboxEntry, RecordInput, Store } from "@grenier/store";
import type { Embedder } from "./embeddings.ts";

/** The team store's address and this device's token. */
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
    readonly detail: string,
  ) {
    super(message);
  }
}

/** One call to the team store's API. Throws TeamError with the store's message. */
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
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const message = (body as { error?: string } | undefined)?.error ?? `HTTP ${response.status}`;
    throw new TeamError(`the team store answered: ${message}`, response.status, message);
  }
  return body as T;
}

/** A record as the team store sends it. */
interface Remote {
  id: string;
  space: string;
  type: string;
  kind: string | null;
  title: string;
  body: string;
  fields: Record<string, unknown>;
  author: string;
  device: string | null;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  retiredAt: number | null;
  version: number;
  anchors: FullRecord["anchors"];
  links: FullRecord["links"];
  sealed: string | null;
}

const SEALED_PARTS = ["type", "kind", "title", "body", "fields", "anchors", "links"] as const;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** A `me` record as it leaves: everything but its id and dates encrypted with the person's own key. */
export async function sealRecord(key: string, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const secret = Object.fromEntries(SEALED_PARTS.map((part) => [part, record[part] ?? null]));
  const sealed = await seal(key, String(record.id), new TextEncoder().encode(JSON.stringify(secret)));
  return {
    ...record,
    type: "Sealed",
    kind: null,
    title: "",
    body: "",
    fields: {},
    anchors: [],
    links: [],
    sealed: toBase64(sealed),
  };
}

async function openRecord(key: string, remote: Remote): Promise<Remote> {
  const plaintext = await open(key, remote.id, fromBase64(remote.sealed as string));
  return { ...remote, ...(JSON.parse(new TextDecoder().decode(plaintext)) as Partial<Remote>), sealed: null };
}

export interface SyncDeps {
  store: Store;
  team: TeamClient;
  embedder: Embedder | null;
  /** The person's own key for the `me` space; without it, `me` records stay here. */
  personalKey: string | null;
  now?: () => number;
}

export interface SyncResult {
  pushed: number;
  refused: { recordId: string; reason: string }[];
  pulled: number;
  /** `me` records this machine could not open: its personal key is not the one they were sealed with. */
  unopened: number;
}

/** The changes waiting for the team store, as it takes them. */
async function outgoing(deps: SyncDeps, entries: readonly OutboxEntry[]) {
  const changes: { id: string; recordId: string; baseVersion: number; changed: string[]; record: unknown }[] = [];
  for (const entry of entries) {
    const change = entry.change as { changed: string[]; record: Record<string, unknown> };
    let record = change.record;
    let changed = change.changed;
    if (record.space === "me") {
      if (!deps.personalKey) continue;
      record = await sealRecord(deps.personalKey, record);
      changed = [...new Set([...changed, ...SEALED_PARTS, "sealed"])];
    } else {
      // Out of `me`, the team store holds only the sealed copy: every part goes again, in the clear.
      if (changed.includes("space")) {
        record = { ...record, sealed: null };
        changed = [...new Set([...changed, ...SEALED_PARTS, "sealed"])];
      }
      const space = await deps.store.spaces.get(String(record.space));
      if (space?.kind === "repo") record = { ...record, spaceName: space.name };
    }
    changes.push({ id: entry.id, recordId: entry.recordId, baseVersion: entry.baseVersion, changed, record });
  }
  return changes;
}

/**
 * One round of sync: send what this machine changed, then take what changed on the team store since the last round.
 * The local copy stays usable offline: when the store cannot be reached this throws, and nothing local is lost.
 */
export async function syncOnce(deps: SyncDeps): Promise<SyncResult> {
  const { store, team } = deps;
  const result: SyncResult = { pushed: 0, refused: [], pulled: 0, unopened: 0 };

  for (;;) {
    // Without the personal key, `me` changes wait here; they must not hold back the others.
    const entries = await store.outbox.pending(200, !deps.personalKey);
    const changes = await outgoing(deps, entries);
    if (changes.length === 0) break;
    const answer = await teamApi<{
      applied: { id: string; recordId: string; version: number }[];
      refused: { id: string; reason: string }[];
    }>(team, "/api/changes", { body: { changes } });
    for (const applied of answer.applied) {
      const local = await store.records.get(applied.recordId);
      if (local && local.version < applied.version) await store.records.setVersion(applied.recordId, applied.version);
    }
    await store.outbox.remove(answer.applied.map((applied) => applied.id));
    for (const refused of answer.refused) {
      await store.outbox.refuse(refused.id, refused.reason);
      const entry = entries.find((candidate) => candidate.id === refused.id);
      result.refused.push({ recordId: entry?.recordId ?? refused.id, reason: refused.reason });
    }
    result.pushed += answer.applied.length;
    if (answer.applied.length === 0) break;
  }

  const me = await store.state.get("team_me_space");
  let cursor = Number((await store.state.get("team_cursor")) ?? 0);
  const waiting = new Set((await store.outbox.list()).map((entry) => entry.recordId));
  for (;;) {
    const page = await teamApi<{
      records: Remote[];
      next: number;
      version: number;
      spaces: { id: string; name: string; kind: "team" | "repo" | "custom"; repoId: string | null }[];
    }>(team, `/api/changes?after=${cursor}&limit=500`);
    for (const space of page.spaces) {
      if (space.id.startsWith("me:")) continue;
      const local = await store.spaces.get(space.id);
      await store.spaces.put({
        id: space.id,
        name: local?.name ?? space.name,
        kind: space.kind,
        repoId: space.repoId,
        root: local?.root ?? null,
      });
    }
    for (let remote of page.records) {
      if (waiting.has(remote.id)) continue;
      if (remote.space === me) {
        if (!deps.personalKey) {
          result.unopened += 1;
          continue;
        }
        try {
          remote = { ...(await openRecord(deps.personalKey, remote)), space: "me" };
        } catch (error) {
          if (!(error instanceof VaultError)) throw error;
          result.unopened += 1;
          continue;
        }
      }
      const { sealed: _sealed, ...rest } = remote;
      const record: RecordInput = rest;
      const before = await store.records.get(record.id);
      const [vector] =
        deps.embedder && (!before || before.title !== record.title || before.body !== record.body)
          ? await deps.embedder.embed([`${record.title}\n${record.body}`.slice(0, 2000)])
          : [];
      await store.records.put(record, vector && deps.embedder ? { model: deps.embedder.model, vector } : undefined);
      const { anchors, links, ...row } = record;
      await store.history.add({
        recordId: record.id,
        version: record.version,
        author: record.author,
        device: record.device,
        ts: record.updatedAt,
        snapshot: { ...row, anchors, links },
      });
      result.pulled += 1;
    }
    cursor = page.next;
    await store.state.set("team_cursor", String(cursor));
    if (page.records.length === 0 || cursor >= page.version) break;
  }

  await pushUsage(deps);
  await store.state.set("last_sync", String((deps.now ?? Date.now)()));
  return result;
}

/** This machine's usage by day and repository folder, as totals the team store replaces. */
async function pushUsage(deps: SyncDeps): Promise<void> {
  const since = (deps.now ?? Date.now)() - 35 * 86_400_000;
  const rows = await deps.store.usage.list({ since });
  const runs = await deps.store.runs.list({ since, limit: 10_000 });
  const totals = new Map<string, Record<string, number | string>>();
  for (const row of rows) {
    const day = new Date(row.ts).toISOString().slice(0, 10);
    const repo = (row.repoRoot ?? row.cwd ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
    const key = `${day}\u0000${repo}`;
    const total = totals.get(key) ?? {
      day,
      repo,
      requests: 0,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cost: 0,
      routineMinutes: 0,
    };
    total.requests = Number(total.requests) + 1;
    total.inputTokens = Number(total.inputTokens) + (row.inputTokens ?? 0);
    total.cacheWriteTokens = Number(total.cacheWriteTokens) + (row.cacheWriteTokens ?? 0);
    total.cacheReadTokens = Number(total.cacheReadTokens) + (row.cacheReadTokens ?? 0);
    total.outputTokens = Number(total.outputTokens) + (row.outputTokens ?? 0);
    total.cost = Number(total.cost) + (row.cost ?? 0);
    totals.set(key, total);
  }
  for (const run of runs) {
    if (!run.endedAt) continue;
    const day = new Date(run.startedAt).toISOString().slice(0, 10);
    const key = `${day}\u0000`;
    const total = totals.get(key) ?? {
      day,
      repo: "",
      requests: 0,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cost: 0,
      routineMinutes: 0,
    };
    total.routineMinutes = Number(total.routineMinutes) + (run.endedAt - run.startedAt) / 60_000;
    totals.set(key, total);
  }
  if (totals.size === 0) return;
  await teamApi(deps.team, "/api/usage", { method: "PUT", body: { rows: [...totals.values()] } });
}
