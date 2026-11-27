import { folderName, folderProblem, randomHex, sha256, TOPS, topName } from "@grenier/core";
import type { RecordInput, Store } from "@grenier/store";
import type { Embedder } from "./embeddings.ts";

/** A repository as the store knows it: where it is on this machine, and its id across machines. */
export interface Repo {
  root: string;
  id: string;
  /** Where the repository lives on this machine, when `root` is a linked worktree of it, such as a run's checkout. */
  home?: string;
}

export interface RepoFiles {
  /** Current blob hash of each path (relative to the root), null for a missing file. */
  hashes(root: string, paths: readonly string[]): Promise<Map<string, string | null>>;
  /** Every tracked file with its staged blob hash. */
  tracked(root: string): Promise<{ path: string; blob: string }[]>;
  /** The path relative to the root with forward slashes, or null when it is outside the repository. */
  relative(root: string, path: string): string | null;
  /** A text file of the work tree, or null. Without it, records are not checked against their files. */
  text?(root: string, path: string): Promise<string | null>;
}

/** Who writes: the team member's name (or this computer's user, outside a team) and this machine's name. */
export interface Identity {
  member: string;
  device: string;
}

export interface StoreDeps {
  store: Store;
  /** Null when embeddings are off or the model could not be loaded: search is then full-text only. */
  embedder: Embedder | null;
  files: RepoFiles;
  me: Identity;
  now?: () => number;
}

/** A client of the MCP server: its scope says whether it reads Me, Team or both. */
export interface Reader {
  id: string;
  name: string;
  /** "me", "team", or "*" for both. */
  scopes: readonly string[];
}

export class StoreUseError extends Error {
  override name = "StoreUseError";
}

export const newId = () => randomHex(12);

/** A record this machine's person starts: `parts` says what it is, the rest is what every new record has. */
export function newRecord(
  me: Identity,
  parts: Pick<RecordInput, "top" | "type" | "title"> & Partial<RecordInput>,
): RecordInput {
  const now = Date.now();
  return {
    id: newId(),
    folder: "",
    body: "",
    fields: {},
    author: me.member,
    device: me.device,
    sessionId: null,
    createdAt: now,
    updatedAt: now,
    retiredAt: null,
    version: 0,
    anchors: [],
    links: [],
    ...parts,
  };
}

/** The top folders the reader's scope names: Me, Team or both; nothing without a reader. */
export function readable(reader: Reader | null): string[] {
  if (reader?.scopes.includes("*")) return [...TOPS];
  return TOPS.filter((top) => reader?.scopes.includes(top));
}

/** The top folder and folder a path names, as "Team/Decisions/2026": its first part is Me or Team. */
export function resolveFolderPath(folderPath: string): { top: string; folder: string } {
  const [first = "", ...rest] = folderPath.split("/").map((name) => name.trim());
  const top = TOPS.find((id) => id === first.toLowerCase() || topName(id).toLowerCase() === first.toLowerCase());
  if (!top) throw new StoreUseError(`no top folder ${first}: a path starts with Me or Team`);
  const folder = rest.join("/");
  const problem = folderProblem(folder);
  if (problem) throw new StoreUseError(problem);
  return { top, folder };
}

/** Records where the repository lives on this machine, and gives its name: a page about its code goes under it. */
export async function ensureRepo(store: Store, repo: Repo): Promise<string> {
  const root = repo.home ?? repo.root;
  const name = (await store.repos.get(repo.id))?.name ?? (folderName(root) || repo.id.slice(0, 8));
  await store.repos.put({ id: repo.id, name, root });
  return name;
}

/** The blob hash of each file, or for a directory a hash over its tracked files' paths and blobs. */
export async function contentHashes(
  deps: StoreDeps,
  repo: Repo,
  paths: readonly string[],
): Promise<Map<string, string | null>> {
  const files = await deps.files.hashes(repo.root, paths);
  const result = new Map<string, string | null>();
  let tracked: { path: string; blob: string }[] | undefined;
  for (const path of paths) {
    const file = files.get(path);
    if (file) {
      result.set(path, file);
      continue;
    }
    tracked ??= await deps.files.tracked(repo.root);
    const prefix = `${path.replace(/\/$/, "")}/`;
    const inside = tracked.filter((entry) => entry.path.startsWith(prefix));
    result.set(
      path,
      inside.length === 0 ? null : `tree:${await sha256(inside.map((e) => `${e.path} ${e.blob}`).join("\n"))}`,
    );
  }
  return result;
}

export function inRepo(deps: StoreDeps, repo: Repo, paths: readonly string[]): string[] {
  const relative: string[] = [];
  for (const path of paths) {
    const inside = deps.files.relative(repo.root, path);
    if (inside === null) throw new StoreUseError(`${path} is outside the repository`);
    if (!relative.includes(inside)) relative.push(inside);
  }
  return relative;
}
