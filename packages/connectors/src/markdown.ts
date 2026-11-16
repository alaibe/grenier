import { type FSWatcher, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { ConnectorError, type Pull, type PulledItem } from "./source.ts";

const EXTENSIONS = new Set([".md", ".markdown"]);

function walk(root: string, dir = root, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, path, found);
    else if (entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      found.push(relative(root, path).split(sep).join("/"));
    }
  }
  return found;
}

/** The front matter's title, date and people (a YAML list or `[a, b]`), and the text after it. */
export function readFrontMatter(text: string): { title?: string; date?: string; people: string[]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { people: [], body: text };
  const meta: { title?: string; date?: string; people: string[] } = { people: [] };
  let inPeople = false;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (inPeople && item) {
      meta.people.push(unquote(item[1] ?? ""));
      continue;
    }
    inPeople = false;
    const field = /^(\w+):\s*(.*)$/.exec(line);
    if (!field) continue;
    const [, key, value = ""] = field;
    if (key === "title" && value) meta.title = unquote(value);
    if (key === "date" && value) meta.date = unquote(value);
    if (key === "people") {
      if (value.startsWith("["))
        meta.people = value.slice(1, value.lastIndexOf("]")).split(",").map(unquote).filter(Boolean);
      else inPeople = true;
    }
  }
  return { ...meta, body: text.slice(match[0].length) };
}

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, "$2");
}

function toItem(root: string, path: string): PulledItem {
  const file = join(root, path);
  const text = readFileSync(file, "utf8");
  const meta = readFrontMatter(text);
  const heading = /^#\s+(.+)$/m.exec(meta.body)?.[1]?.trim();
  const dated = meta.date ? Date.parse(meta.date) : Number.NaN;
  return {
    key: path,
    kind: "note",
    title: meta.title ?? heading ?? basename(path, extname(path)),
    body: meta.body.trim(),
    people: meta.people,
    ts: Number.isNaN(dated) ? Math.round(statSync(file).mtimeMs) : dated,
  };
}

/**
 * A folder of markdown notes. Only files whose modification time or size changed since the last pull are read
 * again; files that are gone are removed.
 */
export async function pullMarkdown(config: Record<string, unknown>, state: Record<string, unknown>): Promise<Pull> {
  const root = config.path;
  if (typeof root !== "string" || !statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ConnectorError(`not a folder: ${String(root)}`);
  }
  const seen = (state.files ?? {}) as Record<string, string>;
  const files: Record<string, string> = {};
  const items: PulledItem[] = [];
  for (const path of walk(root)) {
    const stat = statSync(join(root, path));
    const stamp = `${Math.round(stat.mtimeMs)}:${stat.size}`;
    files[path] = stamp;
    if (seen[path] !== stamp) items.push(toItem(root, path));
  }
  const removed = Object.keys(seen).filter((path) => !(path in files));
  return { items, removed, state: { files } };
}

/** Calls `onChange` (at most every `delay` ms) whenever something changes in the folder. */
export function watchMarkdown(path: string, onChange: () => void, delay = 500): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(path, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, delay);
  });
  watcher.on("close", () => clearTimeout(timer));
  return watcher;
}
