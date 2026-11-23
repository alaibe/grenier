import { sha256 } from "@grenier/core";
import type { Store } from "@grenier/store";
import { type Reader, StoreUseError } from "./records.ts";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Only the hash is kept. */
export async function newClientToken(): Promise<{ token: string; hash: string }> {
  const token = `gc_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { token, hash: await sha256(token) };
}

/** "*" for every space, or space ids and names, kept as ids. */
export async function resolveScopes(store: Store, scopes: readonly string[]): Promise<string[]> {
  if (scopes.includes("*")) return ["*"];
  const spaces = await store.spaces.list();
  const kept: string[] = [];
  for (const scope of scopes) {
    const space = spaces.find((candidate) => candidate.id === scope || candidate.name === scope);
    if (!space) {
      throw new StoreUseError(
        `unknown space ${scope}: use * for every space, or ${spaces.map((candidate) => candidate.id).join(", ")}`,
      );
    }
    if (!kept.includes(space.id)) kept.push(space.id);
  }
  return kept;
}

/** Returns the client's token, shown once. */
export async function addClient(store: Store, name: string, scopes: string[]): Promise<string> {
  if (!/^[\w.@-]{1,64}$/.test(name)) throw new StoreUseError("a client name takes letters, digits and . _ @ -");
  if ((await store.clients.list()).some((client) => client.name === name)) {
    throw new StoreUseError(`there is already a client named ${name}; revoke it first in the app's Settings`);
  }
  const kept = await resolveScopes(store, scopes);
  const { token, hash } = await newClientToken();
  await store.clients.add({ id: crypto.randomUUID(), name, tokenHash: hash, scopes: kept, createdAt: Date.now() });
  return token;
}

export async function readerFor(store: Store, token: string | undefined): Promise<Reader | null> {
  if (!token) return null;
  const client = await store.clients.findActive(await sha256(token));
  return client ? { id: client.id, name: client.name, scopes: client.scopes } : null;
}
