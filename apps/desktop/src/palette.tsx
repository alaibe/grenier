import type { PageRow } from "@grenier/core/api";
import { FileText, type LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api.ts";
import { PLACE_ICONS, PLACES } from "./shell/places.ts";
import { Kbd } from "./ui.tsx";
import { SCREENS, type ViewName } from "./usage/screens.ts";

export interface Command {
  label: string;
  icon: LucideIcon;
  keys?: string[];
  run: () => void;
}

interface Entry extends Command {
  id: string;
  group: "Go to" | "Actions" | "Pages";
}

/** The part of `label` that matches `query`, in the accent. */
function marked(label: string, query: string): ReactNode {
  const at = query ? label.toLowerCase().indexOf(query) : -1;
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark className="bg-transparent text-accent">{label.slice(at, at + query.length)}</mark>
      {label.slice(at + query.length)}
    </>
  );
}

/** ⌘K: every place, every command and every page, by name. `>` keeps the commands, `#` the pages. */
export function Palette({
  go,
  commands,
  onClose,
}: {
  go: (view: ViewName, focus?: string) => void;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<PageRow[]>([]);
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ pages: PageRow[] }>("/pages")
      .then((answer) => setPages(answer.pages))
      .catch(() => setPages([]));
  }, []);

  const entries = useMemo(() => {
    const only = query.startsWith(">") ? "Actions" : query.startsWith("#") ? "Pages" : null;
    const words = query.replace(/^[>#]/, "").trim().toLowerCase();
    const all: Entry[] = [
      ...PLACES.map((name, index) => ({
        id: `place:${name}`,
        group: "Go to" as const,
        label: SCREENS[name].title,
        icon: PLACE_ICONS[name],
        keys: ["⌘", String(index + 1)],
        run: () => go(name),
      })),
      ...commands.map((command) => ({ ...command, id: `command:${command.label}`, group: "Actions" as const })),
      ...(words
        ? pages.map((page) => ({
            id: `page:${page.id}`,
            group: "Pages" as const,
            label: page.title,
            icon: FileText,
            run: () => go("knowledge", page.id),
          }))
        : []),
    ];
    return all
      .filter((entry) => (!only || entry.group === only) && entry.label.toLowerCase().includes(words))
      .slice(0, 30);
  }, [query, pages, commands, go]);

  const words = query.replace(/^[>#]/, "").trim().toLowerCase();
  const current = Math.min(selected, Math.max(entries.length - 1, 0));
  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  });

  return createPortal(
    <div className="fixed inset-0 z-(--layer-palette) bg-void/50" onPointerDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
        className="chamfer-tl mx-auto mt-[18vh] w-140 max-w-[calc(100vw-32px)] border border-line-strong bg-panel shadow-(--shadow-dialog)"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-12 items-center gap-2.5 border-b border-line px-3.5 font-mono text-md">
          <span className="text-accent" aria-hidden="true">
            &gt;
          </span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={entries[current] ? `palette-${current}` : undefined}
            aria-label="Command or page"
            placeholder="Go to, run, or find a page"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              else if (event.key === "ArrowDown") setSelected((index) => Math.min(index + 1, entries.length - 1));
              else if (event.key === "ArrowUp") setSelected((index) => Math.max(index - 1, 0));
              else if (event.key === "Enter") run(entries[current]);
              else return;
              event.preventDefault();
            }}
            className="flex-1 bg-transparent font-mono text-md text-fg caret-accent outline-none placeholder:text-subtle focus-visible:shadow-none"
          />
        </div>
        <div ref={list} id="palette-list" role="listbox" className="max-h-90 overflow-y-auto py-1">
          {entries.length === 0 && <p className="px-3.5 py-3 text-sm text-muted">Nothing matches “{words}”.</p>}
          {entries.map((entry, index) => (
            <div key={entry.id}>
              {entry.group !== entries[index - 1]?.group && <p className="label px-3.5 pt-2.5 pb-1">{entry.group}</p>}
              <div
                id={`palette-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === current}
                className={`relative flex h-9 cursor-pointer items-center gap-2.5 px-3.5 text-base ${index === current ? "bg-accent-soft before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent" : ""}`}
                onPointerMove={() => setSelected(index)}
                onClick={() => run(entry)}
                onKeyDown={() => {}}
              >
                <entry.icon size={15} strokeWidth={1.75} className="text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{marked(entry.label, words)}</span>
                {entry.keys && (
                  <span className="flex gap-0.5">
                    {entry.keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="flex h-7 items-center gap-3.5 bg-void px-3.5 font-mono text-2xs text-muted">
          <span>↵ run</span>
          <span>↑↓ move</span>
          <span>esc close</span>
          <span>&gt; commands</span>
          <span># pages</span>
        </p>
      </div>
    </div>,
    document.body,
  );
}
