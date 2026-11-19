import { sha256 } from "@grenier/core";
import type { Store } from "@grenier/store";
import { CacheError } from "./cache.ts";
import { type Reader, SCOPE_KINDS } from "./personal.ts";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A client token as clients are given them (`gc_` and 32 random bytes), and the SHA-256 kept instead. */
export async function newClientToken(): Promise<{ token: string; hash: string }> {
  const token = `gc_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { token, hash: await sha256(token) };
}

/** A scope as typed (kinds and source names) as it is kept: each source name replaced by that source's id. */
const KINDS: readonly string[] = SCOPE_KINDS;

/** A scope as typed (kinds and source names) as it is kept: each source name replaced by that source's id. */
export async function resolveScopes(store: Store, scopes: readonly string[]): Promise<string[]> {
  const sources = await store.sources.list();
  const ids = new Map(sources.map((source) => [source.name, source.id]));
  const unknown = scopes.filter((scope) => !KINDS.includes(scope) && !ids.has(scope));
  if (unknown.length > 0) {
    throw new CacheError(`unknown scope ${unknown.join(", ")}: use ${[...KINDS, ...ids.keys()].join(", ")}`);
  }
  return scopes.map((scope) => ids.get(scope) ?? scope);
}

/** A kept scope as people read it, given the sources: ids back to names; a source removed since is left out. */
export function scopeNames(scopes: readonly string[], sources: readonly { id: string; name: string }[]): string[] {
  const names = new Map(sources.map((source) => [source.id, source.name]));
  return scopes.flatMap((scope) => (KINDS.includes(scope) ? [scope] : (names.get(scope) ?? [])));
}

/**
 * Creates a client with its scope (kinds and source names, kept as source ids); returns its token, shown once. Throws
 * CacheError when the name is taken or a scope names nothing.
 */
export async function addClient(store: Store, name: string, scopes: string[]): Promise<string> {
  if (!/^[\w.@-]{1,64}$/.test(name)) throw new CacheError("a client name takes letters, digits and . _ @ -");
  if ((await store.clients.list()).some((client) => client.name === name)) {
    throw new CacheError(`there is already a client named ${name}; revoke it first (grenier clients revoke ${name})`);
  }
  const kept = await resolveScopes(store, scopes);
  const { token, hash } = await newClientToken();
  await store.clients.add({ id: crypto.randomUUID(), name, tokenHash: hash, scopes: kept, createdAt: Date.now() });
  return token;
}

/** The client holding this token, as a reader, unless it is revoked. */
export async function readerFor(store: Store, token: string | undefined): Promise<Reader | null> {
  if (!token) return null;
  const client = await store.clients.findActive(await sha256(token));
  return client ? { id: client.id, name: client.name, scopes: client.scopes } : null;
}
