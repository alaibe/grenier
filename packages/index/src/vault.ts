import { open, seal, sha256, VaultError } from "@grenier/core";
import type { Store } from "@grenier/store";
import type { TeamClient } from "./sync.ts";

/** What one device shares with its user's other devices: the sources put in the vault, and approved memories if
 * `memory` is one of them. */
export interface VaultSnapshot {
  version: 1;
  device: string;
  memories: { id: string; title: string; text: string; ts: number }[];
  sources: { name: string; kind: string; config: Record<string, unknown> }[];
}

async function vaultFetch(team: TeamClient, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await (team.fetch ?? fetch)(new URL(path, team.url), {
    ...init,
    headers: { authorization: `Bearer ${team.token}`, ...(init.headers as Record<string, string> | undefined) },
  });
  if (!response.ok && response.status !== 404) {
    const message =
      ((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`;
    throw new VaultError(`the team server answered: ${message}`);
  }
  return response;
}

async function snapshot(store: Store, device: string): Promise<VaultSnapshot> {
  const shared = (await store.sources.list()).filter((source) => source.vault);
  const memories: VaultSnapshot["memories"] = [];
  if (shared.some((source) => source.kind === "memory")) {
    for (const id of await store.items.ids("memory")) {
      const item = await store.items.get(id);
      if (item) memories.push({ id: item.id, title: item.title, text: item.body, ts: item.ts });
    }
  }
  const sources = shared
    .filter((source) => source.kind !== "memory")
    .map((source) => ({ name: source.name, kind: source.kind, config: source.config }));
  return { version: 1, device, memories, sources };
}

/**
 * Encrypts this device's snapshot with the vault key and stores it on the team server as
 * `device-<id>.bin`, unless it is the same as the last one pushed. Returns whether it was pushed.
 */
export async function vaultPush(store: Store, team: TeamClient, key: string, device: string): Promise<boolean> {
  const name = `device-${device}.bin`;
  const plaintext = new TextEncoder().encode(JSON.stringify(await snapshot(store, device)));
  const hash = await sha256(new TextDecoder().decode(plaintext));
  if ((await store.team.get("vault_pushed")) === hash) return false;
  await vaultFetch(team, `/api/vault/${name}`, { method: "PUT", body: await seal(key, name, plaintext) });
  await store.team.set("vault_pushed", hash);
  return true;
}

/**
 * Reads every device's snapshot, decrypts it with the vault key, and adds what this device lacks: memories it has
 * not got, and sources it has no source of that name for (their passwords still come from each device's own command
 * or env var). Throws VaultError when an object does not open with this key.
 */
export async function vaultPull(
  store: Store,
  team: TeamClient,
  key: string,
  device: string,
): Promise<{ memories: number; sources: number }> {
  const listed = (await (await vaultFetch(team, "/api/vault")).json()) as { objects: { name: string }[] };
  let memories = 0;
  let sources = 0;
  for (const { name } of listed.objects) {
    if (name === `device-${device}.bin` || !name.startsWith("device-")) continue;
    const response = await vaultFetch(team, `/api/vault/${name}`);
    if (response.status === 404) continue;
    const plaintext = await open(key, name, new Uint8Array(await response.arrayBuffer()));
    const other = JSON.parse(new TextDecoder().decode(plaintext)) as VaultSnapshot;
    for (const memory of other.memories) {
      if (await store.items.get(memory.id)) continue;
      await store.items.put({
        id: memory.id,
        sourceId: "memory",
        kind: "memory",
        title: memory.title,
        body: memory.text,
        people: [],
        ts: memory.ts,
        contentHash: await sha256(memory.text),
      });
      memories += 1;
    }
    for (const source of other.sources) {
      if (await store.sources.get(source.name)) continue;
      if (!["markdown", "imap", "caldav", "ics"].includes(source.kind)) continue;
      await store.sources.add({
        id: crypto.randomUUID(),
        name: source.name,
        kind: source.kind as "markdown" | "imap" | "caldav" | "ics",
        config: source.config,
      });
      sources += 1;
    }
  }
  return { memories, sources };
}
