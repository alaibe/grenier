import { copiedLines, MAX_CODE_LINES, MAX_QUESTION, sha256, unshareable } from "@grenier/core";
import type { Store } from "@grenier/store";
import { cosine, type Embedder } from "./embeddings.ts";

/** A repository as the cache knows it: where it is on this machine, and its id across machines. */
export interface Repo {
  root: string;
  id: string;
}

/** The repository operations the cache needs, so tests can stand in for git. */
export interface RepoFiles {
  /** Current blob hash of each path (relative to the root), null for a missing file. */
  hashes(root: string, paths: readonly string[]): Promise<Map<string, string | null>>;
  /** Every tracked file with its staged blob hash. */
  tracked(root: string): Promise<{ path: string; blob: string }[]>;
  /** The path relative to the root with forward slashes, or null when it is outside the repository. */
  relative(root: string, path: string): string | null;
  /** A text file of the work tree, or null. Without it, answers are not checked against their files. */
  text?(root: string, path: string): Promise<string | null>;
}

export interface CacheDeps {
  store: Store;
  /** Null when embeddings are off or the model could not be loaded: search is then full-text only. */
  embedder: Embedder | null;
  files: RepoFiles;
  now?: () => number;
  /** Who records: "local", or a team member's id. */
  author?: string;
}

export class CacheError extends Error {
  override name = "CacheError";
}

/** A cosine at or above this makes an answer a candidate on its own. */
export const SIMILAR = 0.45;
/** A full-text match on at least this many of the question's terms makes an answer a candidate. */
const SHARED_TERMS = 2;
const STOPWORDS = new Set(
  "a an and are as at be been by can could do does did for from has have how i in is it its of on or should so that the their them then there these this to was we were what when where which who why will with would you your".split(
    " ",
  ),
);

/** The words of a question worth searching for: lowercase, without stopwords or one-letter words. */
export function terms(question: string): string[] {
  const words = question.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)))];
}

/** A crude stem, so "streamed" and "streaming" count as one shared term. The index itself uses Porter. */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, "").padEnd(3, word);
}

/** A summary describes code; it may quote a short snippet, not the file. Throws CacheError. */
export function checkSummary(summary: string): void {
  const problem = unshareable(summary);
  if (problem) throw new CacheError(`the summary is refused: ${problem}`);
}

/** Against the files themselves, the text may not copy more than a short run of their lines. */
async function checkCopies(deps: CacheDeps, repo: Repo, what: string, text: string, paths: readonly string[]) {
  if (!deps.files.text) return;
  for (const path of paths) {
    const source = await deps.files.text(repo.root, path);
    const copied = source === null ? 0 : copiedLines(text, source);
    if (copied > MAX_CODE_LINES) {
      throw new CacheError(
        `the ${what} is refused: it copies ${copied} lines of ${path}; describe the code and quote at most ${MAX_CODE_LINES} lines of it`,
      );
    }
  }
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function inRepo(deps: CacheDeps, repo: Repo, paths: readonly string[]): string[] {
  const relative: string[] = [];
  for (const path of paths) {
    const inside = deps.files.relative(repo.root, path);
    if (inside === null) throw new CacheError(`${path} is outside the repository`);
    if (!relative.includes(inside)) relative.push(inside);
  }
  return relative;
}

/** record_answer: keeps an answer with the current blob hash of every file it was worked out from. */
export async function recordAnswer(
  deps: CacheDeps,
  repo: Repo,
  input: { question: string; answer: string; files: readonly string[] },
): Promise<{ id: string }> {
  const question = input.question.trim();
  const answer = input.answer.trim();
  if (question === "" || answer === "") throw new CacheError("question and answer must not be empty");
  if (question.length > MAX_QUESTION) throw new CacheError(`the question holds at most ${MAX_QUESTION} characters`);
  const asked = unshareable(question);
  if (asked) throw new CacheError(`the question is refused: ${asked}`);
  const problem = unshareable(answer);
  if (problem) throw new CacheError(`the answer is refused: ${problem}`);
  if (input.files.length === 0) throw new CacheError("list the files the answer was worked out from");

  const paths = inRepo(deps, repo, input.files);
  const hashes = await deps.files.hashes(repo.root, paths);
  const missing = paths.filter((path) => !hashes.get(path));
  if (missing.length > 0) throw new CacheError(`no such file: ${missing.join(", ")}`);
  await checkCopies(deps, repo, "question", question, paths);
  await checkCopies(deps, repo, "answer", answer, paths);

  const id = newId();
  const [vector] = deps.embedder ? await deps.embedder.embed([question]) : [];
  await deps.store.answers.add(
    { id, repoId: repo.id, question, answer, createdAt: (deps.now ?? Date.now)(), author: deps.author ?? "local" },
    paths.map((path) => ({ path, blobHash: hashes.get(path) as string })),
    vector && deps.embedder ? { model: deps.embedder.model, vector } : undefined,
  );
  return { id };
}

export interface AskResult {
  status: "hit" | "stale" | "miss";
  /** The question the answer was recorded for, which may be worded differently. */
  question?: string;
  answer?: string;
  sources: { path: string; blobHash: string }[];
  /** Files edited or deleted since the answer was recorded: re-read these before relying on it. */
  changed: string[];
  id?: string;
  /** How close the recorded question is to the one asked (cosine of their vectors), when embeddings are on. */
  similarity?: number;
}

/**
 * ask_codebase: the best recorded answer to this question, by full-text and vector search fused by rank; between
 * answers ranked alike, the one whose question means the closest wins. A `hit`
 * while every source file still has its recorded blob hash, `stale` with the changed paths otherwise, `miss` when
 * nothing recorded is close enough.
 */
export async function askCodebase(
  deps: CacheDeps,
  repo: Repo,
  input: { question: string /** False to look without counting a hit as a reuse. */; count?: boolean },
): Promise<AskResult> {
  const words = terms(input.question);
  const candidates = new Map<string, number>();
  const fuse = (id: string, rank: number) => candidates.set(id, (candidates.get(id) ?? 0) + 1 / (60 + rank));

  const textMatches = await deps.store.answers.search(repo.id, words, 20);
  for (const [rank, match] of textMatches.entries()) {
    const answer = await deps.store.answers.get(match.id);
    if (!answer) continue;
    const asked = new Set(words.map(stem));
    const shared = new Set(
      terms(`${answer.question} ${answer.answer}`)
        .map(stem)
        .filter((word) => asked.has(word)),
    );
    if (shared.size >= SHARED_TERMS) fuse(match.id, rank);
  }

  const similarities = new Map<string, number>();
  if (deps.embedder) {
    const [query] = await deps.embedder.embed([input.question]);
    if (query) {
      const scored = (await deps.store.answers.vectors(repo.id, deps.embedder.model))
        .map(({ id, vector }) => ({ id, similarity: cosine(query, vector) }))
        .sort((a, b) => b.similarity - a.similarity);
      for (const { id, similarity } of scored) similarities.set(id, similarity);
      for (const [rank, { id }] of scored.filter(({ similarity }) => similarity >= SIMILAR).entries()) fuse(id, rank);
    }
  }

  const closeness = (id: string) => similarities.get(id) ?? -1;
  const best = [...candidates.entries()].sort((a, b) => b[1] - a[1] || closeness(b[0]) - closeness(a[0]))[0]?.[0];
  const answer = best ? await deps.store.answers.get(best) : undefined;
  if (!answer) return { status: "miss", sources: [], changed: [] };

  const current = await deps.files.hashes(
    repo.root,
    answer.sources.map((source) => source.path),
  );
  const changed = answer.sources.filter((source) => current.get(source.path) !== source.blobHash).map((s) => s.path);
  if (changed.length === 0 && input.count !== false) await deps.store.answers.hit(answer.id);
  const similarity = similarities.get(answer.id);
  return {
    status: changed.length === 0 ? "hit" : "stale",
    question: answer.question,
    answer: answer.answer,
    sources: answer.sources,
    changed,
    id: answer.id,
    ...(similarity === undefined ? {} : { similarity }),
  };
}

/** The blob hash of a file, or for a directory a hash over its tracked files' paths and blobs. */
async function contentHash(deps: CacheDeps, repo: Repo, path: string): Promise<string | null> {
  const file = (await deps.files.hashes(repo.root, [path])).get(path);
  if (file) return file;
  const prefix = `${path.replace(/\/$/, "")}/`;
  const inside = (await deps.files.tracked(repo.root)).filter((entry) => entry.path.startsWith(prefix));
  if (inside.length === 0) return null;
  return `tree:${await sha256(inside.map((entry) => `${entry.path} ${entry.blob}`).join("\n"))}`;
}

/** record_summary: keeps a summary of a file or directory as it is now. */
export async function recordSummary(
  deps: CacheDeps,
  repo: Repo,
  input: { path: string; summary: string },
): Promise<{ path: string; blobHash: string }> {
  checkSummary(input.summary);
  const [path] = inRepo(deps, repo, [input.path]);
  const hash = path ? await contentHash(deps, repo, path) : null;
  if (!path || !hash) throw new CacheError(`no such file or directory: ${input.path}`);
  if (!hash.startsWith("tree:")) await checkCopies(deps, repo, "summary", input.summary, [path]);
  await deps.store.summaries.put({
    repoId: repo.id,
    path,
    blobHash: hash,
    summary: input.summary.trim(),
    createdAt: (deps.now ?? Date.now)(),
  });
  return { path, blobHash: hash };
}

/** file_summary: the summary recorded for this exact content, or a miss. */
export async function fileSummary(
  deps: CacheDeps,
  repo: Repo,
  input: { path: string },
): Promise<{ status: "hit" | "miss"; path: string; summary?: string }> {
  const [path] = inRepo(deps, repo, [input.path]);
  if (!path) return { status: "miss", path: input.path };
  const hash = await contentHash(deps, repo, path);
  const summary = hash ? await deps.store.summaries.get(repo.id, path, hash) : undefined;
  return summary ? { status: "hit", path, summary: summary.summary } : { status: "miss", path };
}

export interface RepoMapEntry {
  path: string;
  kind: "directory" | "file";
  files: number;
  summary?: string;
  /** True when the summary was recorded for content that has changed since. */
  stale?: boolean;
}

/** repo_map: the repository's top-level entries, with the summaries recorded for them. */
export async function repoMap(deps: CacheDeps, repo: Repo): Promise<{ entries: RepoMapEntry[] }> {
  const tracked = await deps.files.tracked(repo.root);
  const summaries = new Map((await deps.store.summaries.latest(repo.id)).map((summary) => [summary.path, summary]));
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
  for (const entry of entries) {
    const summary = summaries.get(entry.path);
    if (!summary) continue;
    entry.summary = summary.summary;
    entry.stale = (await contentHash(deps, repo, entry.path)) !== summary.blobHash;
  }
  return { entries };
}
