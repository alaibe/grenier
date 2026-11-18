export type StepKind = "read" | "edit" | "search" | "list" | "ask";

export interface TraceStep {
  id: number;
  callId: string;
  part: number;
  ts: number;
  tool: string;
  kind: StepKind;
  /** Relative to the repository's root; null for the root itself. */
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  label: string | null;
  outcome: string | null;
}

export interface Trace {
  id: string;
  client: string | null;
  repo: string;
  startedAt: number;
  endedAt: number | null;
  steps: TraceStep[];
  requests: { ts: number; cost: number }[];
}

export interface TraceSummary {
  id: string;
  client: string | null;
  repo: string;
  startedAt: number;
  endedAt: number | null;
  steps: number;
  files: number;
  last: number;
  /** Questions to Grenier's cache, and how many it answered with a hit. */
  asks: number;
  hits: number;
  /** Reads before the first question to the cache: all of them when it never asked. */
  readsBeforeAsk: number;
}

export interface TreeRow {
  /** The path the row stands for, "" for the repository. */
  key: string;
  label: string;
  depth: number;
  file: boolean;
}

export interface Tree {
  rows: TreeRow[];
  /** The row of each step, by its index in the trace. */
  rowOfStep: number[];
  files: Set<string>;
}

interface Node {
  name: string;
  key: string;
  file: boolean;
  target: boolean;
  children: Map<string, Node>;
}

/**
 * The files and directories a trace touched, as an indented tree: the repository first, then directories before files,
 * each in name order. A directory the agent never aimed at and that holds a single directory shares its row.
 */
export function treeOf(repo: string, steps: readonly TraceStep[]): Tree {
  const files = new Set(
    steps.filter((step) => step.path && (step.kind === "read" || step.kind === "edit")).map((step) => step.path ?? ""),
  );
  const root: Node = { name: repo, key: "", file: false, target: true, children: new Map() };
  for (const step of steps) {
    if (!step.path) continue;
    let node = root;
    const parts = step.path.split("/");
    parts.forEach((name, index) => {
      const key = parts.slice(0, index + 1).join("/");
      let child = node.children.get(name);
      if (!child) {
        child = { name, key, file: false, target: false, children: new Map() };
        node.children.set(name, child);
      }
      node = child;
    });
    node.target = true;
    node.file = files.has(step.path);
  }

  const rows: TreeRow[] = [];
  const walk = (node: Node, depth: number, prefix: string) => {
    const only = node.children.size === 1 ? [...node.children.values()][0] : undefined;
    if (node !== root && !node.target && !node.file && only && !only.file) {
      walk(only, depth, `${prefix}${node.name}/`);
      return;
    }
    rows.push({ key: node.key, label: `${prefix}${node.name}`, depth, file: node.file });
    const children = [...node.children.values()].sort(
      (a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name),
    );
    for (const child of children) walk(child, depth + 1, "");
  };
  walk(root, 0, "");

  const index = new Map(rows.map((row, at) => [row.key, at]));
  return { rows, rowOfStep: steps.map((step) => index.get(step.path ?? "") ?? 0), files };
}

const overlaps = (a: TraceStep, b: TraceStep) =>
  (a.startLine ?? 1) <= (b.endLine ?? Number.POSITIVE_INFINITY) &&
  (b.startLine ?? 1) <= (a.endLine ?? Number.POSITIVE_INFINITY);

/** The reads of lines already read, with no change by the agent to the file in between: exploration spent twice. */
export function rereadsOf(steps: readonly TraceStep[]): Set<number> {
  const again = new Set<number>();
  steps.forEach((step, at) => {
    if (step.kind !== "read" || !step.path || step.outcome === "error") return;
    for (let before = at - 1; before >= 0; before--) {
      const earlier = steps[before] as TraceStep;
      if (earlier.path !== step.path) continue;
      if (earlier.kind === "edit") return;
      if (earlier.kind === "read" && earlier.outcome !== "error" && overlaps(earlier, step)) {
        again.add(at);
        return;
      }
    }
  });
  return again;
}

const lines = (step: TraceStep) =>
  step.startLine === null
    ? ""
    : step.endLine === null
      ? ` from line ${step.startLine}`
      : step.endLine === step.startLine
        ? ` line ${step.startLine}`
        : ` lines ${step.startLine}–${step.endLine}`;

const where = (path: string | null) => (path ? path : "the whole repository");

/** One step in words, as the player's caption says it. */
export function describeStep(step: TraceStep): string {
  const failed = step.outcome === "error" ? " (it failed)" : "";
  switch (step.kind) {
    case "read":
      return `Read ${step.path}${lines(step)}${failed}`;
    case "edit":
      return `Changed ${step.path}${lines(step)}${failed}`;
    case "search":
      return `Searched ${where(step.path)}${step.label ? ` for “${step.label}”` : ""}${failed}`;
    case "list":
      return `Listed ${where(step.path)}${step.label ? ` matching ${step.label}` : ""}${failed}`;
    case "ask": {
      const found =
        step.outcome === "hit"
          ? "it knew"
          : step.outcome === "stale"
            ? "its answer was out of date"
            : step.outcome === "miss"
              ? "it did not know yet"
              : "";
      const asked = step.path
        ? `Asked Grenier's cache about ${step.path}`
        : step.label
          ? `Asked Grenier's cache “${step.label}”`
          : "Asked Grenier's cache";
      return `${asked}${found ? `: ${found}` : ""}${failed}`;
    }
  }
}

export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword";

const KEYWORDS = new Set(
  (
    "as async await break case catch class const continue def default defer do elif else enum except export extends " +
    "false finally fn for from func function go if impl implements import in interface let lambda loop match mod mut " +
    "new nil None null package pass pub return self Self static struct super switch this throw trait true True False " +
    "try type typeof undefined use var void where while with yield readonly private public protected interface"
  ).split(" "),
);

const TOKEN =
  /(\/\/.*$|#(?=\s|$).*$|\/\*.*?(?:\*\/|$)|^\s*\*(?:\s.*)?$|--\s.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_]\w*)/g;

/** A line split for colouring: comments, strings, numbers and keywords of the usual languages, line by line. */
export function tokens(line: string): { text: string; kind: TokenKind }[] {
  const out: { text: string; kind: TokenKind }[] = [];
  let last = 0;
  const push = (text: string, kind: TokenKind) => {
    if (text === "") return;
    const previous = out.at(-1);
    if (previous && previous.kind === kind) previous.text += text;
    else out.push({ text, kind });
  };
  for (const match of line.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    push(line.slice(last, start), "plain");
    const [text, comment, string, digits, word] = match;
    if (comment) push(text, "comment");
    else if (string) push(text, "string");
    else if (digits) push(text, "number");
    else push(text, word && KEYWORDS.has(word) ? "keyword" : "plain");
    last = start + text.length;
  }
  push(line.slice(last), "plain");
  return out;
}
