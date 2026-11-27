import { repoTop, searchWords, topName, untrusted } from "@grenier/core";
import type { RecordRow } from "@grenier/core/api";
import type { FullRecord } from "@grenier/store";
import { cosine } from "./embeddings.ts";
import { contentHashes, type Reader, type Repo, readable, type StoreDeps } from "./records.ts";

/** A full-text match on at least this many of the question's terms makes a record a candidate. */
const SHARED_TERMS = 2;
/** A cosine at or above this makes a record a candidate on its own. */
const SIMILAR = 0.45;
const STOPWORDS = new Set(
  "a an and are as at be been by can could do does did for from has have how i in is it its of on or should so that the their them then there these this to was we were what when where which who why will with would you your".split(
    " ",
  ),
);

function terms(question: string): string[] {
  const words = searchWords(question);
  return [...new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)))];
}

/** A crude stem, so "streamed" and "streaming" count as one shared term. The index itself uses Porter. */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, "").padEnd(3, word);
}

export type Status = RecordRow["status"];

export interface Checked {
  status: Status;
  /** Files edited or deleted since the record was written: re-read these before relying on it. */
  changed: string[];
}

/** `unchecked` when a record came from outside items, or from a repository this machine does not have. */
export async function check(deps: StoreDeps, record: FullRecord): Promise<Checked> {
  const git = record.anchors.filter((anchor) => anchor.kind === "git");
  let unchecked = record.anchors.some((anchor) => anchor.kind === "item");
  const changed: string[] = [];
  const byRepo = new Map<string, typeof git>();
  for (const anchor of git) byRepo.set(anchor.repoId ?? "", [...(byRepo.get(anchor.repoId ?? "") ?? []), anchor]);
  for (const [repoId, list] of byRepo) {
    const root = (await deps.store.tops.get(repoTop(repoId)))?.root;
    if (!root) {
      unchecked = true;
      continue;
    }
    const current = await contentHashes(
      deps,
      { root, id: repoId },
      list.map((anchor) => anchor.ref),
    );
    for (const anchor of list) if (current.get(anchor.ref) !== anchor.version) changed.push(anchor.ref);
  }
  if (changed.length > 0) return { status: "stale", changed };
  return { status: unchecked ? "unchecked" : "hit", changed: [] };
}

/** A record as a read gives it: with whether the code it was written from is unchanged. */
export type Found = RecordRow;

async function found(deps: StoreDeps, record: FullRecord, similarity?: number): Promise<Found> {
  const { status, changed } = await check(deps, record);
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    body: record.body,
    fields: record.fields,
    top: record.top,
    folder: record.folder,
    author: record.author,
    updatedAt: record.updatedAt,
    status,
    changed,
    anchors: record.anchors,
    links: record.links,
    ...(similarity === undefined ? {} : { similarity }),
  };
}

export interface RecallResult {
  /** The best match's state, or `miss` when nothing recorded is close enough. */
  status: Status | "miss";
  results: Found[];
}

/** Whether a record sits in `folder` or below it; every record does for an empty folder. */
function inFolder(record: { folder: string }, folder: string | undefined): boolean {
  return !folder || record.folder === folder || record.folder.startsWith(`${folder}/`);
}

/** Full-text and vector search fused by rank; a `hit` on the best one counts as a reuse unless `count` is false. */
export async function recall(
  deps: StoreDeps,
  reader: Reader | null,
  input: {
    query: string;
    repo: Repo | null;
    type?: string;
    top?: string;
    folder?: string;
    limit?: number;
    count?: boolean;
  },
): Promise<RecallResult> {
  let tops = (await readable(deps.store, reader)).map((top) => top.id);
  if (input.top) tops = tops.filter((top) => top === input.top);
  const here = input.repo ? repoTop(input.repo.id) : null;

  const words = terms(input.query);
  const candidates = new Map<string, number>();
  const fuse = (id: string, rank: number) => candidates.set(id, (candidates.get(id) ?? 0) + 1 / (60 + rank));
  const records = new Map<string, FullRecord>();
  const load = async (id: string) => {
    if (!records.has(id)) {
      const record = await deps.store.records.get(id);
      if (record) records.set(id, record);
    }
    return records.get(id);
  };

  for (const [rank, match] of (await deps.store.records.search(words, tops, 30)).entries()) {
    const record = await load(match.id);
    if (!record) continue;
    const asked = new Set(words.map(stem));
    const shared = new Set(
      terms(`${record.title} ${record.body}`)
        .map(stem)
        .filter((word) => asked.has(word)),
    );
    if (shared.size >= Math.min(SHARED_TERMS, asked.size)) fuse(match.id, rank);
  }

  const similarities = new Map<string, number>();
  if (deps.embedder) {
    const [query] = await deps.embedder.embed([input.query]);
    if (query) {
      const scored = (await deps.store.records.vectors(tops, deps.embedder.model))
        .map(({ id, vector }) => ({ id, similarity: cosine(query, vector) }))
        .sort((a, b) => b.similarity - a.similarity);
      for (const { id, similarity } of scored) similarities.set(id, similarity);
      for (const [rank, { id }] of scored.filter(({ similarity }) => similarity >= SIMILAR).entries()) fuse(id, rank);
    }
  }

  const nearness = (top: string) => (top === here ? 3 : top === "team" ? 1 : top === "me" ? 0.5 : 0);
  const ranked: { id: string; score: number }[] = [];
  for (const [id, score] of candidates) {
    const record = await load(id);
    if (!record || (input.type && record.type !== input.type) || !inFolder(record, input.folder)) continue;
    ranked.push({ id, score: score * (1 + nearness(record.top) / 10) });
  }
  const closeness = (id: string) => similarities.get(id) ?? -1;
  ranked.sort((a, b) => b.score - a.score || closeness(b.id) - closeness(a.id));

  const results: Found[] = [];
  for (const { id } of ranked.slice(0, Math.min(input.limit ?? 5, 20))) {
    results.push(await found(deps, records.get(id) as FullRecord, similarities.get(id)));
  }
  const best = results[0];
  if (best?.status === "hit" && input.count !== false) await deps.store.records.hit(best.id);
  return { status: best?.status ?? "miss", results };
}

export interface QueryResult {
  records: Found[];
  /** For one record asked by id: what it links to, and what links to it. */
  linked?: Found[];
}

export async function query(
  deps: StoreDeps,
  reader: Reader | null,
  input: {
    id?: string;
    type?: string;
    top?: string;
    folder?: string;
    retired?: boolean;
    limit?: number;
  },
): Promise<QueryResult> {
  let tops = (await readable(deps.store, reader)).map((top) => top.id);
  if (input.top) tops = tops.filter((top) => top === input.top);
  const limit = Math.min(input.limit ?? 50, 200);

  if (input.id) {
    const one = await deps.store.records.get(input.id);
    if (!one || !tops.includes(one.top)) return { records: [] };
    const outgoing: FullRecord[] = [];
    for (const link of one.links.filter((entry) => entry.kind === "record")) {
      const target = await deps.store.records.get(link.ref);
      if (target && tops.includes(target.top) && target.retiredAt === null) outgoing.push(target);
    }
    const incoming = await deps.store.records.list({ tops, linkedTo: { kind: "record", ref: one.id } });
    const linked = [...outgoing, ...incoming.filter((record) => !outgoing.some((o) => o.id === record.id))];
    return {
      records: [await found(deps, one)],
      linked: await Promise.all(linked.slice(0, limit).map((record) => found(deps, record))),
    };
  }

  const listed = await deps.store.records.list({
    tops,
    ...(input.type ? { type: input.type } : {}),
    ...(input.retired ? { retired: true } : {}),
    limit: 1000,
  });
  const matching = listed.filter((record) => inFolder(record, input.folder));
  return { records: await Promise.all(matching.slice(0, limit).map((record) => found(deps, record))) };
}

/** Every record leaves redacted and marked untrusted, its folder as a folder path, the way agents name where to write. */
export async function deliver<T extends { records?: Found[]; results?: Found[]; linked?: Found[] }>(
  deps: StoreDeps,
  result: T,
): Promise<T & { notice: string }> {
  const names = new Map((await deps.store.tops.list()).map((top) => [top.id, topName(top)]));
  return untrusted(result, (top) => names.get(top) ?? (top === "me" ? "Me" : top));
}
