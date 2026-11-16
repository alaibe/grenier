import { sha256 } from "@grenier/core";
import type { Store } from "@grenier/store";
import { CacheError } from "./cache.ts";
import type { Reader } from "./personal.ts";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A client token as clients are given them (`gc_` and 32 random bytes), and the SHA-256 kept instead (rule 8). */
export async function newClientToken(): Promise<{ token: string; hash: string }> {
  const token = `gc_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { token, hash: await sha256(token) };
}

/** Creates a client with its scope; returns its token, shown once. Throws CacheError when the name is taken. */
export async function addClient(store: Store, name: string, scopes: string[]): Promise<string> {
  if (!/^[\w.@-]{1,64}$/.test(name)) throw new CacheError("a client name takes letters, digits and . _ @ -");
  if ((await store.clients.list()).some((client) => client.name === name)) {
    throw new CacheError(`there is already a client named ${name}; revoke it first (grenier clients revoke ${name})`);
  }
  const { token, hash } = await newClientToken();
  await store.clients.add({ id: crypto.randomUUID(), name, tokenHash: hash, scopes, createdAt: Date.now() });
  return token;
}

/** The client holding this token, as a reader, unless it is revoked. */
export async function readerFor(store: Store, token: string | undefined): Promise<Reader | null> {
  if (!token) return null;
  const client = await store.clients.findActive(await sha256(token));
  return client ? { id: client.id, name: client.name, scopes: client.scopes } : null;
}
