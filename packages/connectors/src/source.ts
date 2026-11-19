import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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

/** An entry a connector could not read, and why. */
export interface Failed {
  key: string;
  reason: string;
}

/** What changed since the state the connector was given, and its state for next time. */
export interface Pull {
  items: PulledItem[];
  removed: string[];
  /** Every item whose key starts with one of these goes too: a mailbox that started over. */
  removedPrefixes?: string[];
  /** Entries that could not be read, left out so they do not hold up the rest; tried again once they change. */
  failed?: Failed[];
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
): Promise<{ added: number; removed: number; failed: Failed[] }> {
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
  const prefixes = (pull.removedPrefixes ?? []).map((prefix) => itemId(source.id, prefix));
  const stale =
    prefixes.length > 0
      ? (await store.items.ids(source.id)).filter((id) => prefixes.some((prefix) => id.startsWith(prefix)))
      : [];
  const removed = await store.items.remove([...pull.removed.map((key) => itemId(source.id, key)), ...stale]);
  await store.sources.saveState(source.id, pull.state, now);
  return { added, removed, failed: pull.failed ?? [] };
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

/** A path as people type it: `~` is their home folder, and a relative path starts from `base`. */
export function localPath(path: string, base: string, home = homedir()): string {
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

/**
 * A command line as its words, quoted the way a shell quotes them ('…', "…" and \), without running a shell. Throws
 * ConnectorError on a quote left open.
 */
export function commandWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] as string;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && /["\\$`]/.test(line[index + 1] ?? "")) word += line[++index];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < line.length) {
      word += line[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new ConnectorError(`the command has a ${quote} left open: ${line}`);
  if (started) words.push(word);
  return words;
}
