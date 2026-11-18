import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { repoText } from "@grenier/connectors/git";
import { redact } from "@grenier/core";
import type { NewStep } from "@grenier/store";
import type { ToolUse } from "./loops.ts";

type Kind = NewStep["kind"];

/** One step of a call, before it gets its session, time and position among the call's steps. */
export interface Draft {
  kind: Kind;
  /** Relative to the repository's root; null for the root itself. */
  path: string | null;
  startLine?: number;
  endLine?: number;
  label?: string;
  outcome?: string;
}

interface Where {
  root: string;
  cwd: string;
  /** Whether a path inside the repository exists: a shell word is kept as a path only if it does. */
  exists?: (path: string) => boolean;
}

const LABEL_LENGTH = 80;
// A long run of letters and digits mixing both reads as a key or a token: it is never kept.
const TOKEN_LIKE = /(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}/g;

function label(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const clean = redact(text.replace(/\s+/g, " ").trim()).replace(TOKEN_LIKE, "[removed]");
  if (clean === "") return undefined;
  return clean.length > LABEL_LENGTH ? `${clean.slice(0, LABEL_LENGTH - 1)}…` : clean;
}

const field = (input: unknown, ...keys: string[]): unknown => {
  if (!input || typeof input !== "object") return undefined;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};
const text = (input: unknown, ...keys: string[]) => {
  const value = field(input, ...keys);
  return typeof value === "string" && value !== "" ? value : undefined;
};
const number = (input: unknown, ...keys: string[]) => {
  const value = field(input, ...keys);
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
};

/** The path inside the repository: "" for its root, null for a path outside it. */
function inside(where: Where, path: string): string | null {
  const absolute = isAbsolute(path) ? path : resolve(where.cwd, path);
  const rel = relative(where.root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function at(where: Where, path: string | undefined, draft: Omit<Draft, "path">, root = false): Draft[] {
  if (path === undefined) return root ? [{ ...draft, path: null }] : [];
  const found = inside(where, path);
  if (found === null || (found === "" && !root)) return [];
  return [{ ...draft, path: found === "" ? null : found }];
}

/** The lines a result shows with their numbers (`cat -n`, as Claude Code's Read and Edit print them). */
function numberedLines(result: string): { startLine: number; endLine: number } | undefined {
  let first: number | undefined;
  let last: number | undefined;
  for (const match of result.matchAll(/^\s*(\d+)(?:→|\t)/gm)) {
    const line = Number(match[1]);
    first = first === undefined ? line : Math.min(first, line);
    last = last === undefined ? line : Math.max(last, line);
  }
  return first === undefined || last === undefined ? undefined : { startLine: first, endLine: last };
}

function patchFiles(where: Where, patch: string): Draft[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].flatMap((match) =>
    at(where, match[1]?.trim(), { kind: "edit" }),
  );
}

/** Splits a shell command into words, keeping quoted text together. Operators come out as words of their own. */
function words(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  const flush = () => {
    if (started) out.push(current);
    current = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    // As in bash: inside double quotes, a backslash escapes only a double quote, a backslash, a dollar or a backtick.
    if (char === "\\" && quote !== "'" && (quote === null || /["\\$`]/.test(command[i + 1] ?? ""))) {
      current += command[++i] ?? "";
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char) && char !== "\n") {
      flush();
    } else if (char === "&" && current.endsWith(">")) {
      current += char;
    } else if (char === "\n" || char === ";" || char === "|" || char === "&") {
      flush();
      const pair = command.slice(i, i + 2);
      out.push(pair === "&&" || pair === "||" ? pair : char === "\n" ? ";" : char);
      if (pair === "&&" || pair === "||") i++;
    } else {
      current += char;
      started = true;
    }
  }
  flush();
  return out;
}

const READERS = new Set(["cat", "bat", "less", "more", "nl", "head", "tail", "wc", "view"]);
const SEARCHERS = new Set(["rg", "grep", "egrep", "ag", "ack"]);
const LISTERS = new Set(["ls", "tree", "find", "fd"]);
const SEARCH_VALUE_FLAGS = new Set([
  "-e",
  "-f",
  "-g",
  "--glob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "-A",
  "-B",
  "-C",
  "-m",
  "--max-count",
  "--max-depth",
  "-d",
  "--include",
  "--exclude",
]);

const looksLikePath = (word: string) => word !== "" && !/[*?$`<>]/.test(word) && !word.startsWith("-");

/** One simple command of a pipeline: what it reads, searches or lists, and a line range it narrows a read to. */
function simple(
  where: Where,
  argv: string[],
  piped: boolean,
): { drafts: Draft[]; range?: { startLine: number; endLine?: number } } {
  const [program = "", ...args] = argv;
  const name = program.split("/").at(-1) ?? program;
  if (READERS.has(name)) {
    let lines: number | undefined;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if ((arg === "-n" || arg === "--lines") && (name === "head" || name === "tail")) {
        lines = Number.parseInt(args[++i] ?? "", 10);
      } else if (/^-\d+$/.test(arg) && name === "head") {
        lines = Number(arg.slice(1));
      } else if (looksLikePath(arg)) {
        files.push(arg);
      }
    }
    const range = name === "head" && lines && lines > 0 ? { startLine: 1, endLine: lines } : undefined;
    return {
      drafts: files.flatMap((file) => at(where, file, { kind: "read", ...(range ?? {}) })),
      ...(range && files.length === 0 ? { range } : {}),
    };
  }
  if (name === "sed") {
    let quiet = false;
    let inPlace = false;
    let script: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg === "-n" || arg === "--quiet") quiet = true;
      else if (arg.startsWith("-i") || arg.startsWith("--in-place")) {
        inPlace = true;
        // BSD sed's `-i ''`: an empty backup suffix, not the script.
        if (arg === "-i" && args[i + 1] === "") i++;
      } else if (arg === "-e" || arg === "--expression") script ??= args[++i];
      else if (!arg.startsWith("-")) positional.push(arg);
    }
    if (script === undefined) script = positional.shift() ?? "";
    const files = positional.filter(looksLikePath);
    if (inPlace) return { drafts: files.flatMap((file) => at(where, file, { kind: "edit" })) };
    const printed = quiet ? /^(\d+)(?:,(\d+))?p$/.exec(script) : null;
    const range = printed ? { startLine: Number(printed[1]), endLine: Number(printed[2] ?? printed[1]) } : undefined;
    return {
      drafts: files.flatMap((file) => at(where, file, { kind: "read", ...(range ?? {}) })),
      ...(range && files.length === 0 ? { range } : {}),
    };
  }
  const search = name === "git" && args[0] === "grep" ? args.slice(1) : SEARCHERS.has(name) ? args : null;
  if (search) {
    let pattern: string | undefined;
    const paths: string[] = [];
    for (let i = 0; i < search.length; i++) {
      const arg = search[i] as string;
      if (arg === "-e") pattern ??= search[i + 1];
      if (SEARCH_VALUE_FLAGS.has(arg)) {
        i++;
      } else if (!arg.startsWith("-")) {
        if (pattern === undefined) pattern = arg;
        else if (looksLikePath(arg)) paths.push(arg);
        // `grep x tests/e2e/*.ts` searches tests/e2e.
        else if (/[*?]/.test(arg)) {
          const directory = arg.slice(0, arg.search(/[*?]/)).replace(/\/[^/]*$/, "");
          if (looksLikePath(directory)) paths.push(directory);
        }
      }
    }
    const shown = label(pattern);
    const draft = { kind: "search" as const, ...(shown ? { label: shown } : {}) };
    // `… | grep -v x` filters what comes down the pipe: it searches no file.
    if (paths.length === 0) return { drafts: piped ? [] : at(where, where.cwd, draft, true) };
    return { drafts: paths.flatMap((path) => at(where, path, draft, true)) };
  }
  if (LISTERS.has(name)) {
    const target = args.find(looksLikePath);
    return { drafts: at(where, target ?? where.cwd, { kind: "list" }, true) };
  }
  return { drafts: [] };
}

/** Takes the redirections out of a command's words: `> f` and `>> f` change f, `< f` reads it. */
function redirections(where: Where, argv: string[]): { argv: string[]; drafts: Draft[] } {
  const rest: string[] = [];
  const drafts: Draft[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    const match = /^\d*(<<-?|>>?|<)(.*)$/.exec(word);
    if (!match) {
      rest.push(word);
      continue;
    }
    const [, operator = "", attached = ""] = match;
    const target = attached !== "" ? attached : argv[++i];
    if (operator.startsWith("<<") || !target || target.startsWith("&") || !looksLikePath(target)) continue;
    drafts.push(...at(where, target, { kind: operator === "<" ? "read" : "edit" }));
  }
  return { argv: rest, drafts };
}

/** The command without its heredocs' bodies: those lines are data, not commands. */
function withoutHeredocs(source: string): string {
  const kept: string[] = [];
  let end: string | null = null;
  for (const line of source.split("\n")) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    kept.push(line);
    end = /<<-?\s*(['"]?)([\w.-]+)\1/.exec(line)?.[2] ?? null;
  }
  return kept.join("\n");
}

/** What a shell command read, searched, listed or changed in the repository, as far as its words tell. */
export function shellSteps(where: Where, command: string | readonly string[]): Draft[] {
  let source = typeof command === "string" ? command : command.join(" ");
  if (Array.isArray(command)) {
    const [program, flag, script] = command as string[];
    if (program && /(^|\/)(ba|z)?sh$/.test(program) && (flag === "-c" || flag === "-lc") && script) source = script;
  }
  if (source.includes("*** Begin Patch")) return patchFiles(where, source);

  const drafts: Draft[] = [];
  let cwd = where.cwd;
  let pipeline: Draft[] = [];
  let piped = false;
  let argv: string[] = [];
  const endCommand = (operator: string) => {
    if (argv[0] === "cd" && argv[1] && looksLikePath(argv[1])) {
      cwd = resolve(cwd, argv[1]);
    } else if (argv.length > 0) {
      const here = { root: where.root, cwd };
      const redirected = redirections(here, argv);
      const { drafts: found, range } = simple(here, redirected.argv, piped);
      found.push(...redirected.drafts);
      // `nl -ba f | sed -n '10,40p'`: the range belongs to what the pipeline read.
      if (range && pipeline.length > 0) {
        for (const draft of pipeline)
          if (draft.kind === "read" && draft.startLine === undefined) Object.assign(draft, range);
      }
      pipeline.push(...found);
    }
    argv = [];
    piped = operator === "|";
    if (!piped) {
      drafts.push(...pipeline);
      pipeline = [];
    }
  };
  for (const word of words(withoutHeredocs(source))) {
    if (word === "|" || word === "&&" || word === "||" || word === ";" || word === "&") endCommand(word);
    else argv.push(word);
  }
  endCommand(";");
  const { exists } = where;
  return exists ? drafts.filter((draft) => draft.path === null || exists(draft.path)) : drafts;
}

/** The step a tool of Grenier's own MCP server stands for: the exploration cache, asked instead of the code. */
function cacheStep(where: Where, name: string, use: ToolUse): Draft[] | null {
  const outcome = /"status":\s*"(hit|stale|miss)"/.exec(use.result?.text ?? "")?.[1];
  const base = { kind: "ask" as const, ...(outcome ? { outcome } : {}) };
  if (name.endsWith("ask_codebase")) {
    const question = label(text(use.input, "question"));
    return [{ ...base, path: null, ...(question ? { label: question } : {}) }];
  }
  if (name.endsWith("file_summary")) return at(where, text(use.input, "path"), base, true);
  if (name.endsWith("repo_map")) return [{ ...base, path: null, label: "repository map" }];
  return null;
}

function drafts(where: Where, use: ToolUse): Draft[] {
  const name = use.tool;
  const input = use.input;
  const lower = name.toLowerCase();
  if (lower.includes("grenier")) return cacheStep(where, lower, use) ?? [];
  const file = text(input, "file_path", "notebook_path", "path");
  switch (name) {
    case "Read": {
      const offset = number(input, "offset");
      const limit = number(input, "limit");
      if (offset === undefined && limit === undefined) return at(where, file, { kind: "read" });
      const start = Math.max(1, offset ?? 1);
      return at(where, file, {
        kind: "read",
        startLine: start,
        ...(limit === undefined ? {} : { endLine: start + Math.max(1, limit) - 1 }),
      });
    }
    case "Edit":
    case "MultiEdit":
      return at(where, file, { kind: "edit", ...(numberedLines(use.result?.text ?? "") ?? {}) });
    case "Write": {
      const content = text(input, "content");
      return at(where, file, {
        kind: "edit",
        ...(content ? { startLine: 1, endLine: content.split("\n").length } : {}),
      });
    }
    case "NotebookEdit":
      return at(where, file, { kind: "edit" });
    case "Grep": {
      const pattern = label(text(input, "pattern"));
      return at(
        where,
        text(input, "path") ?? where.cwd,
        { kind: "search", ...(pattern ? { label: pattern } : {}) },
        true,
      );
    }
    case "Glob": {
      const pattern = label(text(input, "pattern"));
      return at(
        where,
        text(input, "path") ?? where.cwd,
        { kind: "list", ...(pattern ? { label: pattern } : {}) },
        true,
      );
    }
    case "LS":
      return at(where, file ?? where.cwd, { kind: "list" }, true);
    case "str_replace_based_edit_tool":
    case "str_replace_editor": {
      const range = field(input, "view_range");
      if (text(input, "command") !== "view") return at(where, file, { kind: "edit" });
      const [start, end] = Array.isArray(range) ? range : [];
      return at(where, file, {
        kind: "read",
        ...(typeof start === "number" ? { startLine: start } : {}),
        ...(typeof end === "number" && end > 0 ? { endLine: end } : {}),
      });
    }
    case "apply_patch": {
      const patch = typeof input === "string" ? input : text(input, "input", "patch");
      return patch ? patchFiles(where, patch) : [];
    }
  }
  const command = field(input, "command", "cmd");
  if (typeof command === "string" || (Array.isArray(command) && command.every((word) => typeof word === "string"))) {
    const workdir = text(input, "workdir", "working_directory", "cwd");
    return shellSteps({ ...where, cwd: workdir ? resolve(where.cwd, workdir) : where.cwd }, command);
  }
  return [];
}

/**
 * The steps a session's new tool calls took in its repository, ready to store. Reads, edits, searches and listings of
 * paths inside the repository only; a call that touched nothing there leaves no step.
 */
export function stepsOf(
  session: { id: string; repoRoot: string; cwd: string | null },
  uses: readonly ToolUse[],
  ts: number,
): NewStep[] {
  const root = session.repoRoot;
  const where = { root, cwd: session.cwd ?? root, exists: (path: string) => existsSync(join(root, path)) };
  return uses.flatMap((use) =>
    drafts(where, use).map((draft, part) => ({
      sessionId: session.id,
      callId: use.id,
      part,
      ts,
      tool: use.tool.slice(0, 64),
      ...draft,
      ...(use.result?.error ? { outcome: "error" } : {}),
    })),
  );
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/**
 * Puts each edit whose result showed no line numbers (Claude Code's Edit says only that the file was updated) on the
 * lines its new text holds in the file now. An edit whose text is not found keeps no lines.
 */
export async function placeEdits(
  root: string,
  rows: NewStep[],
  uses: readonly ToolUse[],
  read: (root: string, path: string) => Promise<string | null> = repoText,
): Promise<void> {
  const inputs = new Map(uses.map((use) => [use.id, use.input]));
  for (const row of rows) {
    if (row.kind !== "edit" || row.startLine != null || !row.path || row.outcome === "error") continue;
    const input = inputs.get(row.callId);
    const edits = field(input, "edits");
    const needles = [
      field(input, "new_string"),
      ...(Array.isArray(edits) ? edits.map((edit) => field(edit, "new_string")) : []),
    ].filter((needle): needle is string => typeof needle === "string" && needle.trim() !== "");
    if (needles.length === 0) continue;
    const content = await read(root, row.path);
    if (content === null) continue;
    for (const needle of needles) {
      const index = content.indexOf(needle);
      if (index === -1) continue;
      const start = lineOf(content, index);
      const end = start + needle.replace(/\n$/, "").split("\n").length - 1;
      row.startLine = Math.min(row.startLine ?? start, start);
      row.endLine = Math.max(row.endLine ?? end, end);
    }
  }
}
