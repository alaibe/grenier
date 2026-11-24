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

/** "*" for every top folder, or top folder ids and names, kept as ids. */
export async function resolveScopes(store: Store, scopes: readonly string[]): Promise<string[]> {
  if (scopes.includes("*")) return ["*"];
  const tops = await store.tops.list();
  const kept: string[] = [];
  for (const scope of scopes) {
    const top = tops.find((candidate) => candidate.id === scope || candidate.name === scope);
    if (!top) {
      throw new StoreUseError(
        `unknown top folder ${scope}: use * for every one, or ${tops.map((candidate) => candidate.id).join(", ")}`,
      );
    }
    if (!kept.includes(top.id)) kept.push(top.id);
  }
  return kept;
}

/** Returns the client's token, shown once. */
export async function addClient(store: Store, name: string, scopes: string[]): Promise<string> {
  if (!/^[\w.@-]{1,64}$/.test(name)) throw new StoreUseError("an app's name takes letters, digits and . _ @ -");
  if ((await store.clients.list()).some((client) => client.name === name)) {
    throw new StoreUseError(`there is already an app named ${name}: revoke it first`);
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
