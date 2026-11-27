import { MEMBER_NAME, sha256, TOPS, toBase64Url, topName } from "@grenier/core";
import type { Store } from "@grenier/store";
import { type Reader, StoreUseError } from "./records.ts";

/** Only the hash is kept. */
async function newClientToken(): Promise<{ token: string; hash: string }> {
  const token = `gc_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { token, hash: await sha256(token) };
}

/** "*" for both, or Me and Team by id or name, kept as ids. */
export function resolveScopes(scopes: readonly string[]): string[] {
  if (scopes.includes("*")) return ["*"];
  const kept: string[] = [];
  for (const scope of scopes) {
    const top = TOPS.find((id) => id === scope.toLowerCase() || topName(id).toLowerCase() === scope.toLowerCase());
    if (!top) throw new StoreUseError(`unknown top folder ${scope}: use *, me or team`);
    if (!kept.includes(top)) kept.push(top);
  }
  return kept;
}

/** Returns the client's token, shown once. */
export async function addClient(store: Store, name: string, scopes: string[]): Promise<string> {
  if (!MEMBER_NAME.test(name)) throw new StoreUseError("an app's name takes letters, digits and . _ @ -");
  if ((await store.clients.list()).some((client) => client.name === name)) {
    throw new StoreUseError(`there is already an app named ${name}: revoke it first`);
  }
  const kept = resolveScopes(scopes);
  const { token, hash } = await newClientToken();
  await store.clients.add({ id: crypto.randomUUID(), name, tokenHash: hash, scopes: kept, createdAt: Date.now() });
  return token;
}

export async function readerFor(store: Store, token: string | undefined): Promise<Reader | null> {
  if (!token) return null;
  const client = await store.clients.findActive(await sha256(token));
  return client ? { id: client.id, name: client.name, scopes: client.scopes } : null;
}
