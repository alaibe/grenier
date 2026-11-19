import { join, resolve } from "node:path";
import { blobHashes, repoId, repoPath, repoRoot, repoText, trackedFiles } from "@grenier/connectors/git";
import type { Config } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { CacheError, type Embedder, type Repo, type RepoFiles } from "@grenier/index";
import { loadLocalEmbedder } from "@grenier/index/node";

export const gitFiles: RepoFiles = { hashes: blobHashes, tracked: trackedFiles, relative: repoPath, text: repoText };

/**
 * Finds the repository for a tool call: `repo` resolved against `base`, or `base` itself. With no base (the daemon,
 * which serves many repositories), `repo` is required.
 */
export function repoResolver(base: string | null): (repo: string | undefined) => Promise<Repo> {
  const known = new Map<string, Repo>();
  return async (repo) => {
    const path = repo ? resolve(base ?? "/", repo) : base;
    if (path === null) throw new CacheError("pass repo: the path of the repository");
    const cached = known.get(path);
    if (cached) return cached;
    const root = await repoRoot(path);
    if (!root) throw new CacheError(`not inside a git repository: ${path}`);
    const id = await repoId(root);
    if (!id) throw new CacheError(`${root} has no commit yet; the cache needs one to identify the repository`);
    const found = { root, id };
    known.set(path, found);
    return found;
  };
}

/** How long after a failed load of the model the next use tries again. */
export const EMBEDDER_RETRY_MS = 60_000;

/**
 * Loads the embedding model on first use, once. When it cannot be loaded, search falls back to full text, and a use
 * a minute later tries again: a download that failed on a bad connection does not turn embeddings off until restart.
 * `offline` uses only a model already downloaded.
 */
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
      config.cache.embeddings === "off"
        ? Promise.resolve(null)
        : load(join(paths.home, "models"), options).catch((error: unknown) => {
            failedAt = now();
            log(`grenier: embeddings unavailable, using full-text search only: ${(error as Error).message}`);
            return null;
          });
    return loading;
  };
}
