import { join, resolve } from "node:path";
import { blobHashes, repoId, repoPath, repoRoot, trackedFiles } from "@grenier/connectors/git";
import type { Config } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { CacheError, type Embedder, type Repo, type RepoFiles } from "@grenier/index";
import { loadLocalEmbedder } from "@grenier/index/node";

export const gitFiles: RepoFiles = { hashes: blobHashes, tracked: trackedFiles, relative: repoPath };

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

/** Loads the embedding model on first use, once. When it cannot be loaded, search falls back to full text. */
export function embedderLoader(
  config: Config,
  paths: GrenierPaths,
  log: (line: string) => void,
): () => Promise<Embedder | null> {
  let loading: Promise<Embedder | null> | undefined;
  return () => {
    loading ??=
      config.cache.embeddings === "off"
        ? Promise.resolve(null)
        : loadLocalEmbedder(join(paths.home, "models")).catch((error: unknown) => {
            log(`grenier: embeddings unavailable, using full-text search only: ${(error as Error).message}`);
            return null;
          });
    return loading;
  };
}
