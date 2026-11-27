import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { adminToken, startDaemon } from "../daemon.ts";
import { environment, type Io, Refusal, UsageError } from "../io.ts";

/** One call to the daemon's admin API, the one the app uses: its answer, or a Refusal with the daemon's reason. */
export type Admin = <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<T>;

/** The admin API of this machine's daemon, started first when it isn't running. */
export function daemonAdmin(io: Io): Admin {
  let base: Promise<{ url: string; token: string }> | null = null;
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    base ??= startDaemon(io).then(({ port }) => ({
      url: `http://127.0.0.1:${port}/admin`,
      token: adminToken(environment(io).paths),
    }));
    const { url, token } = await base;
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch((error: Error) => {
      throw new Refusal(`the daemon is not answering: ${error.message}`);
    });
    return answerOf<T>(response.status, await response.json().catch(() => ({})));
  };
}

/** A route's answer, or what it refused: a conflict names the page that changed meanwhile. */
export function answerOf<T>(status: number, body: unknown): T {
  const answer = (body ?? {}) as { error?: string; conflict?: unknown };
  if (status >= 400) {
    if (answer.conflict) throw new Refusal("it changed meanwhile: read it again, then make your change");
    throw new Refusal(answer.error ?? `the daemon answered HTTP ${status}`);
  }
  return body as T;
}

export interface Context {
  args: string[];
  flags: Record<string, string | boolean | string[] | undefined>;
  admin: Admin;
  io: Io;
}

interface Option {
  type: "string" | "boolean";
  multiple?: boolean;
}

/** A command: the words after `grenier`, what it takes, what it does, and how its answer reads. */
export interface Command {
  usage: string;
  summary: string;
  options?: Record<string, Option>;
  /** How many words it takes after its own: [least, most]. */
  takes?: [number, number];
  call: (context: Context) => Promise<unknown>;
  /** The answer as text; without it, the answer is printed as JSON. */
  show?: (answer: never) => string;
}

export interface Group {
  summary: string;
  commands: Record<string, Command>;
}

export function usageOf(name: string, group: Group): string {
  const width = Math.max(...Object.values(group.commands).map((command) => command.usage.length));
  return [
    `Usage: grenier ${name} <command>`,
    "",
    group.summary,
    "",
    ...Object.values(group.commands).map((command) => `  ${command.usage.padEnd(width)}  ${command.summary}`),
    "",
    "Every command takes --json, to print the daemon's answer as it is.",
  ].join("\n");
}

/** Runs `grenier <group> <command> …` against the admin API. */
export async function runGroup(name: string, group: Group, argv: string[], io: Io, admin: Admin): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === "help" || verb === "--help" || verb === "-h") {
    io.out(usageOf(name, group));
    return 0;
  }
  const command = group.commands[verb];
  if (!command) throw new UsageError(`${name} has no command "${verb}"\n\n${usageOf(name, group)}`);
  const { values, positionals } = parseArgs({
    args: rest,
    options: { ...(command.options ?? {}), json: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const [least, most] = command.takes ?? [0, 0];
  if (positionals.length < least || positionals.length > most) {
    throw new UsageError(`usage: grenier ${name} ${command.usage}`.trimEnd());
  }
  const answer = await command.call({ args: positionals, flags: values, admin, io });
  if (answer === undefined) return 0;
  if (answer === UNCHANGED && !values.json) {
    io.out("Nothing changed");
    return 0;
  }
  const text = values.json || !command.show ? JSON.stringify(answer, null, 2) : command.show(answer as never);
  if (text) io.out(text);
  return 0;
}

/** Rows as aligned columns, the last one left as long as it is. */
export function table(rows: (string | number | null | undefined)[][]): string {
  const cells = rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))));
  const widths: number[] = [];
  for (const row of cells) {
    for (const [at, cell] of row.entries()) widths[at] = Math.max(widths[at] ?? 0, cell.length);
  }
  return cells
    .map((row) =>
      row
        .map((cell, at) => (at === row.length - 1 ? cell : cell.padEnd(widths[at] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export const when = (ts: number | null | undefined) =>
  ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "never";

/** A text's first line, cut to fit beside the other columns. */
export function firstLine(text: string | null | undefined, max = 80): string {
  const line = (text ?? "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What an edit answers when the person changed nothing, so nothing was sent. */
export const UNCHANGED = { unchanged: true } as const;

/** `NAME=value` split at its first `=`. */
export function splitPair(pair: string): [string, string] {
  const at = pair.indexOf("=");
  if (at <= 0) throw new UsageError(`${pair} is not NAME=value`);
  return [pair.slice(0, at), pair.slice(at + 1)];
}

/** `NAME=value` pairs; with `empty`, `NAME=` stands for null, which removes it. */
export function pairs(given: unknown, empty = false): Record<string, string | null> {
  return Object.fromEntries(
    strings(given).map((pair) => {
      const [name, value] = splitPair(pair);
      return [name, empty && value === "" ? null : value];
    }),
  );
}

export const strings = (given: unknown) => (given as string[] | undefined) ?? [];

/** A text from a file, or from stdin for `-`. */
export function textFrom(source: string): string {
  return readFileSync(source === "-" ? 0 : source, "utf8");
}

/**
 * A text to write: from `--<flag> <file>` or `-` for stdin, else edited in $VISUAL or $EDITOR from what it is now. An
 * editor left without a change gives back null.
 */
export function edited(io: Io, given: unknown, current: string, flag: string): string | null {
  if (typeof given === "string") return textFrom(given);
  const editor = io.env.VISUAL || io.env.EDITOR;
  if (!editor) throw new UsageError(`give --${flag} <file>, or - for stdin, or set $EDITOR`);
  const dir = mkdtempSync(join(tmpdir(), "grenier-edit-"));
  const file = join(dir, "edit.md");
  try {
    writeFileSync(file, current, { mode: 0o600 });
    const done = spawnSync(`${editor} "${file}"`, { shell: true, stdio: "inherit", env: io.env });
    if (done.status !== 0) throw new Refusal(`${editor} exited with ${done.status ?? done.signal}: nothing saved`);
    const text = readFileSync(file, "utf8");
    return text === current ? null : text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The items that go by a word: the one with it as its id, else those with it as their name. */
export function named<T extends { id: string }>(items: T[], wanted: string, name: (item: T) => string): T[] {
  const byId = items.find((item) => item.id === wanted);
  return byId ? [byId] : items.filter((item) => name(item).toLowerCase() === wanted.toLowerCase());
}

/**
 * A text an edit changes, as `edited` gives it, unless the command changes only other things: then undefined, and the
 * editor stays closed.
 */
export function editedUnless(
  io: Io,
  flags: Context["flags"],
  others: readonly string[],
  flag: string,
  current: string,
): string | null | undefined {
  const elsewhere = others.some((name) => flags[name] !== undefined);
  return elsewhere && flags[flag] === undefined ? undefined : edited(io, flags[flag], current, flag);
}

/** One of a list, by its id or else its name: refused when none or several go by it. */
export function pick<T extends { id: string }>(items: T[], wanted: string, what: string, name: (item: T) => string): T {
  const found = named(items, wanted, name);
  if (found.length === 1) return found[0] as T;
  if (found.length === 0) throw new Refusal(`there is no ${what} ${wanted}`);
  throw new Refusal(
    `several ${what}s are named ${wanted}; name one by its id:\n${found.map((item) => item.id).join("\n")}`,
  );
}

/** A command that finds one thing, sends one request about it, and says what it did. */
export function onOne<T>(spec: {
  usage: string;
  summary: string;
  options?: Record<string, Option>;
  find: (admin: Admin, wanted: string, flags: Context["flags"]) => Promise<T>;
  send: (admin: Admin, item: T, flags: Context["flags"]) => Promise<unknown>;
  done: (item: T, answer: Record<string, unknown>) => string;
}): Command {
  return {
    usage: spec.usage,
    summary: spec.summary,
    ...(spec.options ? { options: spec.options } : {}),
    takes: [1, 1],
    call: async ({ admin, args, flags }) => {
      const item = await spec.find(admin, args[0] as string, flags);
      const answer = ((await spec.send(admin, item, flags)) ?? {}) as Record<string, unknown>;
      return { ...answer, done: spec.done(item, answer) };
    },
    show: (answer: { done: string }) => answer.done,
  };
}

export const q = (value: string) => encodeURIComponent(value);
