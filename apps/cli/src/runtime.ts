import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { type Config, newVaultKey } from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { gitFiles, repoHome, repoId, repoRoot } from "@grenier/git";
import { type Embedder, type Identity, type Repo, type StoreDeps, StoreUseError } from "@grenier/index";
import { loadLocalEmbedder } from "@grenier/index/node";
import type { Store } from "@grenier/store";

/** This machine's name as the team sees it: `[machine] name`, else its host name made safe. */
export function deviceName(config: Config): string {
  if (config.machine.name) return config.machine.name;
  const name = hostname()
    .replace(/\.local$/, "")
    .replace(/[^\w.-]+/g, "-")
    .slice(0, 40);
  return name || "machine";
}

/** Who writes from here: the team member this device joined as, else this computer's user. */
export async function identity(store: Store, config: Config): Promise<Identity> {
  const member = (await store.state.get("team_member")) ?? userInfo().username.replace(/[^\w.@-]+/g, "-");
  return { member, device: deviceName(config) };
}

/** A short random session id, safe in a URL path. */
export function newSessionId(): string {
  return randomBytes(9).toString("base64url");
}

export function personalKey(paths: GrenierPaths): string | null {
  return existsSync(paths.personalKey) ? readFileSync(paths.personalKey, "utf8").trim() : null;
}

/** Keeps the personal key in its own file, readable by this user only. */
export function savePersonalKey(paths: GrenierPaths, key: string): void {
  writeFileSync(paths.personalKey, `${key}\n`, { mode: 0o600 });
}

/** The personal key, made the first time it is needed; Settings shows it, to put on the person's other machines. */
export function ensurePersonalKey(paths: GrenierPaths): string {
  const existing = personalKey(paths);
  if (existing) return existing;
  const key = newVaultKey();
  savePersonalKey(paths, key);
  return key;
}

/** The `me` top folder, which every machine has, team or not. */
export async function ensureBaseTops(store: Store): Promise<void> {
  if (!(await store.tops.get("me"))) {
    await store.tops.put({ id: "me", name: "me", kind: "me", repoId: null, root: null });
  }
}

export async function storeDeps(
  store: Store,
  config: Config,
  embedder: () => Promise<Embedder | null>,
): Promise<StoreDeps> {
  await ensureBaseTops(store);
  return { store, files: gitFiles, embedder: await embedder(), me: await identity(store, config) };
}

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
    const found = root && id ? { root, id, home: await repoHome(root) } : null;
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
        : load(paths.models).catch((error: unknown) => {
            failedAt = now();
            log(`grenier: embeddings unavailable, using full-text search only: ${(error as Error).message}`);
            return null;
          });
    return loading;
  };
}

/** A session's addresses on the proxy, and the environment that sends an agent through them. */
export function sessionProxy(
  port: number,
  sessionId: string,
): { base: string; openai: string; env: NodeJS.ProcessEnv } {
  const base = `http://127.0.0.1:${port}/s/${sessionId}`;
  const openai = `${base}/openai/v1`;
  return { base, openai, env: { ANTHROPIC_BASE_URL: base, OPENAI_BASE_URL: openai, GRENIER_SESSION: sessionId } };
}
