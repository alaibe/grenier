import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256 } from "@grenier/core";
import type { Source, Store } from "@grenier/store";

/** One note, message or event as a connector reads it. `key` is unique within its source. */
export interface PulledItem {
  key: string;
  kind: "note" | "mail" | "event";
  title: string;
  body: string;
  people: string[];
  ts: number;
}

/** What changed since the state the connector was given, and its state for next time. */
export interface Pull {
  items: PulledItem[];
  removed: string[];
  state: Record<string, unknown>;
}

export class ConnectorError extends Error {
  override name = "ConnectorError";
}

/** A source's item id: the source id and the connector's key, so two sources never collide. */
export function itemId(sourceId: string, key: string): string {
  return `${sourceId}:${key}`;
}

/** Applies a pull to the store: new and changed items in, removed ones out, then the connector's new state. */
export async function applyPull(
  store: Store,
  source: Pick<Source, "id">,
  pull: Pull,
  now = Date.now(),
): Promise<{ added: number; removed: number }> {
  let added = 0;
  for (const item of pull.items) {
    const changed = await store.items.put({
      id: itemId(source.id, item.key),
      sourceId: source.id,
      kind: item.kind,
      title: item.title,
      body: item.body,
      people: item.people,
      ts: item.ts,
      contentHash: await sha256(JSON.stringify([item.title, item.body, item.people, item.ts])),
    });
    if (changed) added += 1;
  }
  const removed = await store.items.remove(pull.removed.map((key) => itemId(source.id, key)));
  await store.sources.saveState(source.id, pull.state, now);
  return { added, removed };
}

/**
 * A password for a mail or calendar server, never stored: printed by `password_command` (an argument list, such as
 * ["security", "find-generic-password", "-s", "grenier-mail", "-w"]) or read from the env var `password_env`.
 */
export async function secretFor(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const command = config.password_command;
  if (Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string")) {
    const [program, ...args] = command as string[];
    try {
      const { stdout } = await promisify(execFile)(program as string, args, { timeout: 30_000 });
      return stdout.replace(/\r?\n$/, "");
    } catch (error) {
      throw new ConnectorError(`the password command failed: ${(error as Error).message}`);
    }
  }
  if (typeof config.password_env === "string" && config.password_env) {
    const value = env[config.password_env];
    if (value) return value;
    throw new ConnectorError(`the environment variable ${config.password_env} is not set`);
  }
  throw new ConnectorError("the source has no password_command or password_env");
}
