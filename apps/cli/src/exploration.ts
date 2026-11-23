import { join, resolve } from "node:path";
import { blobHashes, repoId, repoPath, repoRoot, repoText, trackedFiles } from "@grenier/connectors/git";
import type { Config } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { type Embedder, type Repo, type RepoFiles, StoreUseError } from "@grenier/index";
import { loadLocalEmbedder } from "@grenier/index/node";

export const gitFiles: RepoFiles = { hashes: blobHashes, tracked: trackedFiles, relative: repoPath, text: repoText };

/** `repo` resolved against `base`, or `base` itself; null outside a repository, an error for a wrong `repo`. */
export function repoResolver(base: string | null): (repo: string | undefined) => Promise<Repo | null> {
  const known = new Map<string, Repo | null>();
  return async (repo) => {
    const path = repo ? resolve(base ?? "/", repo) : base;
    if (path === null) return null;
    if (known.has(path)) return known.get(path) ?? null;
    const root = await repoRoot(path);
    const id = root ? await repoId(root) : null;
    if (repo && !root) throw new StoreUseError(`not inside a git repository: ${path}`);
    if (repo && !id)
      throw new StoreUseError(`${root} has no commit yet; the store needs one to identify the repository`);
    const found = root && id ? { root, id } : null;
    known.set(path, found);
    return found;
  };
}

/** How long after a failed load of the model the next use tries again. */
export const EMBEDDER_RETRY_MS = 60_000;

/** Loads the embedding model on first use; after a failed load, search uses full text and retries a minute later. */
export function embedderLoader(
  config: Config,
  paths: GrenierPaths,
  log: (line: string) => void,
  options: { offline?: boolean } = {},
  deps: { load?: typeof loadLocalEmbedder; now?: () => number } = {},
): () => Promise<Embedder | null> {
  const load = deps.load ?? loadLocalEmbedder;
  const now = deps.now ?? Date.now;
  let loading: Promise<Embedder | null> | undefined;
  let failedAt: number | null = null;
  return () => {
    if (failedAt !== null && now() - failedAt >= EMBEDDER_RETRY_MS) {
      loading = undefined;
      failedAt = null;
    }
    loading ??=
      config.store.embeddings === "off"
        ? Promise.resolve(null)
        : load(join(paths.home, "models"), options).catch((error: unknown) => {
            failedAt = now();
            log(`grenier: embeddings unavailable, using full-text search only: ${(error as Error).message}`);
            return null;
          });
    return loading;
  };
}
