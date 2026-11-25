import type { PageRow } from "@grenier/core/api";
import { FileText, type LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.ts";
import { Keys } from "../ui/keycap.tsx";
import { mac, type Shortcut } from "../ui/keys.ts";
import { type Command, useLayer, useRegistryState } from "./commands.tsx";

interface Entry {
  id: string;
  group: "Actions" | "Go to" | "Pages";
  label: string;
  icon: LucideIcon | undefined;
  keys: Shortcut | undefined;
  run: () => void;
}

/** Where the query's letters fall in the label, in order: the whole word first, else each letter after the last. */
function matchOf(label: string, query: string): number[] | null {
  if (!query) return [];
  const lower = label.toLowerCase();
  const at = lower.indexOf(query);
  if (at >= 0) return Array.from({ length: query.length }, (_, index) => at + index);
  const found: number[] = [];
  let from = 0;
  for (const char of query) {
    const next = lower.indexOf(char, from);
    if (next < 0) return null;
    found.push(next);
    from = next + 1;
  }
  return found;
}

function marked(label: string, letters: number[]): ReactNode {
  if (letters.length === 0) return label;
  const set = new Set(letters);
  return [...label].map((char, index) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: the letters of a label have no other identity
    set.has(index) ? <mark key={index}>{char}</mark> : char,
  );
}

const fromCommand = (command: Command): Entry => ({
  id: command.id,
  group: command.group ?? "Actions",
  label: command.label,
  icon: command.icon,
  keys: command.keys,
  run: command.run,
});

/**
 * ⌘K (components/command-palette.md): every action, every place and every page, by name. `>` keeps the actions, `#`
 * the pages. ↑↓ move, Enter runs, ⌘Enter runs and stays open, Esc closes.
 */
export function Palette({ openPage, onClose }: { openPage: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<PageRow[]>([]);
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const { registry } = useRegistryState();
  useLayer("palette");

  useEffect(() => {
    api<{ pages: PageRow[] }>("/pages")
      .then((answer) => setPages(answer.pages))
      .catch(() => setPages([]));
  }, []);

  const only = query.startsWith(">") ? "Actions" : query.startsWith("#") ? "Pages" : null;
  const words = query.replace(/^[>#]/, "").trim().toLowerCase();
  const commands = registry.commands;
  const entries = useMemo(() => {
    const all: Entry[] = [
      ...commands.filter((command) => !command.hidden && command.group === "Go to").map(fromCommand),
      ...commands.filter((command) => !command.hidden && command.group !== "Go to").map(fromCommand),
      ...(words || only === "Pages"
        ? pages.map((page) => ({
            id: `page:${page.id}`,
            group: "Pages" as const,
            label: page.title,
            icon: FileText,
            keys: undefined,
            run: () => openPage(page.id),
          }))
        : []),
    ];
    return all
      .filter((entry) => !only || entry.group === only || (only === "Actions" && entry.group === "Go to"))
      .map((entry) => ({ entry, letters: matchOf(entry.label, words) }))
      .filter((found): found is { entry: Entry; letters: number[] } => found.letters !== null)
      .sort(
        (a, b) => Number(isWhole(b.letters)) - Number(isWhole(a.letters)) || groupOrder(a.entry) - groupOrder(b.entry),
      )
      .slice(0, 40);
  }, [commands, pages, words, only, openPage]);

  const current = Math.min(selected, Math.max(entries.length - 1, 0));
  const run = (found: { entry: Entry } | undefined, stay = false) => {
    if (!found) return;
    if (!stay) onClose();
    found.entry.run();
  };

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  });

  return createPortal(
    <div
      className="fixed inset-0 grid justify-items-center bg-void/50 px-4 pt-[20vh]"
      style={{ zIndex: "var(--layer-palette)", alignItems: "start" }}
      onPointerDown={onClose}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="palette-input">
          <span className="palette-prompt" aria-hidden="true">
            &gt;
          </span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={entries[current] ? `palette-${current}` : undefined}
            aria-label="Command, place or page"
            placeholder="Go to, run, or find a page"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"))
                onClose();
              else if (event.key === "ArrowDown") setSelected(Math.min(current + 1, entries.length - 1));
              else if (event.key === "ArrowUp") setSelected(Math.max(current - 1, 0));
              else if (event.key === "Enter") run(entries[current], event.metaKey || event.ctrlKey);
              else return;
              event.preventDefault();
              event.stopPropagation();
            }}
          />
        </div>
        <div ref={list} className="palette-results max-h-[360px] overflow-y-auto" id="palette-results" role="listbox">
          {entries.length === 0 && <p className="px-4 py-3 text-muted">No command matches “{words}”.</p>}
          {entries.map(({ entry, letters }, index) => (
            <div key={entry.id}>
              {entry.group !== entries[index - 1]?.entry.group && (
                <div className="palette-group label">{entry.group}</div>
              )}
              <div
                id={`palette-${index}`}
                className="palette-item"
                role="option"
                tabIndex={-1}
                aria-selected={index === current}
                onPointerMove={() => setSelected(index)}
                onClick={() => run({ entry })}
                onKeyDown={() => {}}
              >
                {entry.icon && <entry.icon className="icon" aria-hidden="true" />}
                <span className={`min-w-0 flex-1 truncate${entry.group === "Pages" ? " palette-item-content" : ""}`}>
                  {marked(entry.label, letters)}
                </span>
                {entry.keys && <Keys shortcut={entry.keys} />}
              </div>
            </div>
          ))}
        </div>
        <div className="palette-footer">
          <span>↵ run</span>
          <span>{mac ? "⌘↵" : "Ctrl+Enter"} run, stay open</span>
          <span>↑↓ move</span>
          <span>esc close</span>
          <span>&gt; actions · # pages</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const isWhole = (letters: number[]) =>
  letters.every((at, index) => index === 0 || at === (letters[index - 1] ?? 0) + 1);

const groupOrder = (entry: Entry) => (entry.group === "Go to" ? 0 : entry.group === "Actions" ? 1 : 2);
