import { repoTop, topName, untrusted } from "@grenier/core";
import type { FullRecord, Link, Store } from "@grenier/store";
import { cosine } from "./embeddings.ts";
import { contentHashes, ensureRepoTop, inRepo, type Reader, type Repo, readable, type StoreDeps } from "./records.ts";

/** A full-text match on at least this many of the question's terms makes a record a candidate. */
const SHARED_TERMS = 2;
/** A cosine at or above this makes a record a candidate on its own. */
export const SIMILAR = 0.45;
const STOPWORDS = new Set(
  "a an and are as at be been by can could do does did for from has have how i in is it its of on or should so that the their them then there these this to was we were what when where which who why will with would you your".split(
    " ",
  ),
);

export function terms(question: string): string[] {
  const words = question.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)))];
}

/** A crude stem, so "streamed" and "streaming" count as one shared term. The index itself uses Porter. */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, "").padEnd(3, word);
}

export type Status = "hit" | "stale" | "unchecked";

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

export interface Found {
  id: string;
  type: string;
  kind: string | null;
  title: string;
  body: string;
  fields: Record<string, unknown>;
  top: string;
  /** Where it sits in its top folder. */
  folder: string;
  author: string;
  updatedAt: number;
  status: Status;
  changed: string[];
  anchors: FullRecord["anchors"];
  links: FullRecord["links"];
  /** How close it is to the question (cosine), when embeddings are on. */
  similarity?: number;
}

async function found(deps: StoreDeps, record: FullRecord, similarity?: number): Promise<Found> {
  const { status, changed } = await check(deps, record);
  return {
    id: record.id,
    type: record.type,
    kind: record.kind,
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
export function inFolder(record: { folder: string }, folder: string | undefined): boolean {
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
  if (input.repo) await ensureRepoTop(deps.store, input.repo);
  let tops = (await readable(deps.store, reader)).map((top) => top.id);
  if (input.top) tops = tops.filter((top) => top === input.top);
  const here = input.repo ? repoTop(input.repo.id) : null;
  const linkedRepos = here ? await projectRepos(deps.store, tops, input.repo?.id as string) : new Set<string>();

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

  const nearness = (top: string) =>
    top === here ? 3 : linkedRepos.has(top) ? 2 : top === "team" ? 1 : top === "me" ? 0.5 : 0;
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

/** The top folders of the other repositories of the projects that link this one. */
async function projectRepos(store: Store, tops: readonly string[], repoId: string): Promise<Set<string>> {
  const projects = await store.records.list({ tops, type: "Project", linkedTo: { kind: "repo", ref: repoId } });
  const repos = new Set<string>();
  for (const project of projects) {
    for (const link of project.links) if (link.kind === "repo" && link.ref !== repoId) repos.add(repoTop(link.ref));
  }
  return repos;
}

export interface QueryResult {
  records: Found[];
  /** For one record asked by id or title: what it links to, and what links to it. */
  linked?: Found[];
}

export async function query(
  deps: StoreDeps,
  reader: Reader | null,
  input: {
    id?: string;
    title?: string;
    type?: string;
    top?: string;
    folder?: string;
    fields?: Record<string, string>;
    linkedTo?: { kind: Link["kind"]; ref: string };
    retired?: boolean;
    limit?: number;
  },
): Promise<QueryResult> {
  let tops = (await readable(deps.store, reader)).map((top) => top.id);
  if (input.top) tops = tops.filter((top) => top === input.top);
  const limit = Math.min(input.limit ?? 50, 200);

  if (input.id || input.title) {
    const one = input.id
      ? await deps.store.records.get(input.id)
      : (await deps.store.records.list({ tops, ...(input.type ? { type: input.type } : {}) })).find(
          (record) => record.title.toLowerCase() === input.title?.trim().toLowerCase(),
        );
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
    ...(input.linkedTo ? { linkedTo: input.linkedTo } : {}),
    ...(input.retired ? { retired: true } : {}),
    limit: 1000,
  });
  const matching = listed.filter(
    (record) =>
      inFolder(record, input.folder) &&
      Object.entries(input.fields ?? {}).every(([name, value]) => String(record.fields[name] ?? "") === value),
  );
  return { records: await Promise.all(matching.slice(0, limit).map((record) => found(deps, record))) };
}

export async function fileSummary(
  deps: StoreDeps,
  repo: Repo,
  input: { path: string },
): Promise<{ status: "hit" | "miss"; path: string; summary?: string; notice?: string }> {
  const [path] = inRepo(deps, repo, [input.path]);
  if (!path) return { status: "miss", path: input.path };
  const top = await ensureRepoTop(deps.store, repo);
  const hash = (await contentHashes(deps, repo, [path])).get(path);
  const summary = (await deps.store.records.list({ tops: [top], type: "Memory", kind: "summary" })).find(
    (record) => record.fields.path === path && record.anchors.some((a) => a.ref === path && a.version === hash),
  );
  if (!summary) return { status: "miss", path };
  const { records, notice } = untrusted({ records: [summary] });
  return { status: "hit", path, summary: records[0]?.body ?? "", notice };
}

export interface RepoMapEntry {
  path: string;
  kind: "directory" | "file";
  files: number;
  /** Redacted and marked untrusted, as every record's text leaves. */
  summary?: string;
  /** True when the summary was recorded for content that has changed since. */
  stale?: boolean;
}

export async function repoMap(deps: StoreDeps, repo: Repo): Promise<{ entries: RepoMapEntry[]; notice: string }> {
  const folder = await ensureRepoTop(deps.store, repo);
  const tracked = await deps.files.tracked(repo.root);
  const summaries = new Map<string, FullRecord>();
  for (const record of await deps.store.records.list({ tops: [folder], type: "Memory", kind: "summary" })) {
    const path = String(record.fields.path ?? "");
    if (path && !summaries.has(path)) summaries.set(path, record);
  }
  const top = new Map<string, RepoMapEntry>();
  for (const { path } of tracked) {
    const slash = path.indexOf("/");
    const name = slash === -1 ? path : path.slice(0, slash);
    const entry = top.get(name) ?? { path: name, kind: slash === -1 ? "file" : "directory", files: 0 };
    entry.files += 1;
    top.set(name, entry);
  }
  const entries = [...top.values()].sort((a, b) =>
    a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "directory" ? -1 : 1,
  );
  const shown = untrusted({ records: entries.flatMap((entry) => summaries.get(entry.path) ?? []) });
  const bodies = new Map(shown.records.map((record) => [record.id, record.body]));
  for (const entry of entries) {
    const summary = summaries.get(entry.path);
    if (!summary) continue;
    entry.summary = bodies.get(summary.id) ?? "";
    const hash = (await contentHashes(deps, repo, [entry.path])).get(entry.path);
    entry.stale = !summary.anchors.some((anchor) => anchor.ref === entry.path && anchor.version === hash);
  }
  return { entries, notice: shown.notice };
}

/** Every record leaves redacted and marked untrusted, its folder as a folder path, the way agents name where to write. */
export async function deliver<T extends { records?: Found[]; results?: Found[]; linked?: Found[] }>(
  deps: StoreDeps,
  result: T,
): Promise<T & { notice: string }> {
  const names = new Map((await deps.store.tops.list()).map((top) => [top.id, topName(top)]));
  return untrusted(result, (top) => names.get(top) ?? (top === "me" ? "Me" : top));
}
