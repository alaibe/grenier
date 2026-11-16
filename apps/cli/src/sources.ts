import { createHash, randomBytes, randomUUID } from "node:crypto";
import { applyPull, pullSource } from "@grenier/connectors";
import type { Reader } from "@grenier/index";
import type { Source, Store } from "@grenier/store";

/** Pulls one source and applies what changed. */
export async function syncSource(store: Store, source: Source): Promise<{ added: number; removed: number } | null> {
  const pulling = pullSource(source);
  if (!pulling) return null;
  return applyPull(store, source, await pulling);
}

/** Pulls every source in turn; one that fails is reported and does not stop the others. */
export async function syncSources(
  store: Store,
  log: (line: string) => void,
  only?: string,
): Promise<{ name: string; added: number; removed: number; error?: string }[]> {
  const results: { name: string; added: number; removed: number; error?: string }[] = [];
  for (const source of await store.sources.list()) {
    if (only && source.name !== only) continue;
    try {
      const result = await syncSource(store, source);
      if (result) results.push({ name: source.name, ...result });
    } catch (error) {
      const message = (error as Error).message;
      log(`grenier: could not sync ${source.name}: ${message}`);
      results.push({ name: source.name, added: 0, removed: 0, error: message });
    }
  }
  return results;
}

/** A client token as clients are given them, and the SHA-256 the database keeps instead (rule 8). */
export function newClientToken(): { token: string; hash: string } {
  const token = `gc_${randomBytes(32).toString("base64url")}`;
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

/** Creates a client with its scope; returns its token, which is shown once. Throws when the name is taken. */
export async function addClient(store: Store, name: string, scopes: string[]): Promise<string> {
  if (!/^[\w.@-]{1,64}$/.test(name)) throw new Error("a client name takes letters, digits and . _ @ -");
  if ((await store.clients.list()).some((client) => client.name === name)) {
    throw new Error(`there is already a client named ${name}; revoke it first (grenier clients revoke ${name})`);
  }
  const { token, hash } = newClientToken();
  await store.clients.add({ id: randomUUID(), name, tokenHash: hash, scopes, createdAt: Date.now() });
  return token;
}

/** The client holding this token, as a reader, unless it is revoked. */
export async function readerFor(store: Store, token: string | undefined): Promise<Reader | null> {
  if (!token) return null;
  const client = await store.clients.findActive(createHash("sha256").update(token).digest("hex"));
  return client ? { id: client.id, name: client.name, scopes: client.scopes } : null;
}
