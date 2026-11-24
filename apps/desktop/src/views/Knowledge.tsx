import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type PageRow, type RecordRow, type Top } from "../api.ts";
import { Empty, Input, Loading, Notice, useLoad } from "../ui.tsx";
import { PageEditor, type Place, placeKey, placeLabel, type Target, topName } from "./Record.tsx";

const loadTops = () => api<{ tops: Top[] }>("/tops").then((answer) => answer.tops);
const loadPages = () => api<{ pages: PageRow[] }>("/pages").then((answer) => answer.pages);

interface Folder {
  name: string;
  /** "Decisions/2026"; empty for a top folder. */
  path: string;
  folders: Folder[];
  pages: PageRow[];
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** One top folder's tree: folders first, then pages, each by name. */
function treeOf(pages: PageRow[]): Folder {
  const top: Folder = { name: "", path: "", folders: [], pages: [] };
  for (const page of pages) {
    let folder = top;
    for (const name of page.folder ? page.folder.split("/") : []) {
      const path = folder.path ? `${folder.path}/${name}` : name;
      let next = folder.folders.find((entry) => entry.name === name);
      if (!next) {
        next = { name, path, folders: [], pages: [] };
        folder.folders.push(next);
      }
      folder = next;
    }
    folder.pages.push(page);
  }
  const sort = (folder: Folder) => {
    folder.folders.sort((a, b) => byName.compare(a.name, b.name));
    folder.pages.sort((a, b) => byName.compare(a.title, b.title));
    folder.folders.forEach(sort);
  };
  sort(top);
  return top;
}

function foldersIn(folder: Folder): string[] {
  return folder.folders.flatMap((child) => [child.path, ...foldersIn(child)]);
}

const FOLDING_KEY = "grenier.knowledge.folding";

/** A top folder's key ends with "/": its path is empty. */
const isTop = (key: string) => key.endsWith("/");

/** Whether a folder shows what it holds: top folders start unfolded, the rest folded. Kept in this browser only. */
function useFolding(): [(key: string) => boolean, (key: string, open?: boolean) => void] {
  const [flipped, setFlipped] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOLDING_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const unfolded = useCallback((key: string) => flipped.has(key) !== isTop(key), [flipped]);
  const fold = useCallback((key: string, open?: boolean) => {
    setFlipped((current) => {
      const next = new Set(current);
      const wasOpen = current.has(key) !== isTop(key);
      if ((open ?? !wasOpen) === wasOpen) return current;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(FOLDING_KEY, JSON.stringify([...next]));
      } catch {
        // Private windows refuse storage: folders then start as they would.
      }
      return next;
    });
  }, []);
  return [unfolded, fold];
}

const ORDER: Record<Top["kind"], number> = { me: 0, team: 1, repo: 2, custom: 3 };

const folderKey = (top: string, path: string) => `${top}/${path}`;

export function Knowledge({ focus, changed, member }: ViewProps) {
  const tops = useLoad(loadTops);
  const pages = useLoad(loadPages);
  const [target, setTarget] = useState<Target | null>(focus ? { id: focus } : null);
  const [words, setWords] = useState("");
  const [unfolded, toggle] = useFolding();

  const trees = useMemo(
    () =>
      [...(tops.data ?? [])]
        .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || byName.compare(a.name, b.name))
        .map((top) => ({
          top,
          tree: treeOf((pages.data ?? []).filter((page) => page.top === top.id)),
        })),
    [tops.data, pages.data],
  );
  const places: Place[] = useMemo(
    () =>
      trees.flatMap(({ top, tree }) =>
        ["", ...foldersIn(tree)].map((folder) => ({
          top: top.id,
          folder,
          label: placeLabel(tops.data ?? [], top.id, folder),
        })),
      ),
    [trees, tops.data],
  );

  // A page opened from elsewhere shows where it sits.
  const openId = target && "id" in target ? target.id : null;
  useEffect(() => {
    const page = pages.data?.find((entry) => entry.id === openId);
    if (!page) return;
    toggle(folderKey(page.top, ""), true);
    const names = page.folder ? page.folder.split("/") : [];
    for (let depth = 1; depth <= names.length; depth++)
      toggle(folderKey(page.top, names.slice(0, depth).join("/")), true);
  }, [openId, pages.data, toggle]);

  const open = (id: string) => setTarget({ id });
  const reload = () => {
    pages.reload();
    changed();
  };

  if (tops.error || pages.error) return <Notice message={tops.error ?? pages.error} />;
  if (!tops.data || !pages.data) return <Loading what="Knowledge" />;

  return (
    <div className="grid grid-cols-[264px_minmax(0,1fr)] gap-8 max-md:grid-cols-1">
      <nav aria-label="Pages" className="min-w-0">
        <Input
          type="search"
          placeholder="Search"
          aria-label="Search the pages"
          value={words}
          onChange={(event) => setWords(event.currentTarget.value)}
        />
        <div className="mt-3">
          {words.trim().length >= 2 ? (
            <Found words={words.trim()} pages={pages.data} tops={tops.data} open={open} current={openId} />
          ) : (
            trees.map(({ top, tree }) => (
              <TopFolder
                key={top.id}
                top={top}
                tree={tree}
                name={topName(tops.data ?? [], top.id)}
                unfolded={unfolded}
                toggle={toggle}
                current={openId}
                open={open}
                start={!member || top.kind === "me" ? (folder) => setTarget({ top: top.id, folder }) : null}
                moved={reload}
              />
            ))
          )}
        </div>
      </nav>
      <section className="min-w-0">
        {target ? (
          <PageEditor
            key={"id" in target ? target.id : `new:${placeKey(target)}`}
            target={target}
            places={places}
            tops={tops.data}
            member={member}
            open={open}
            changed={reload}
            closed={() => setTarget(null)}
          />
        ) : (
          <Empty>
            <p>Pick a page, or start one with + beside a folder.</p>
          </Empty>
        )}
      </section>
    </div>
  );
}

const SAYS: Record<Top["kind"], string> = {
  me: "only you",
  team: "everyone",
  repo: "repository",
  custom: "some members",
};

function TopFolder({
  top,
  tree,
  name,
  unfolded,
  toggle,
  current,
  open,
  start,
  moved,
}: {
  top: Top;
  tree: Folder;
  name: string;
  unfolded: (key: string) => boolean;
  toggle: (key: string, open?: boolean) => void;
  current: string | null;
  open: (id: string) => void;
  /** Null where this person may not write. */
  start: ((folder: string) => void) | null;
  moved: () => void;
}) {
  const shown = unfolded(folderKey(top.id, ""));
  return (
    <div className="mb-1">
      <Row
        depth={0}
        unfolded={shown}
        onClick={() => toggle(folderKey(top.id, ""))}
        actions={start && <Actions start={() => start("")} add={(child) => start(child)} />}
      >
        <span className="font-semibold">{name}</span>
        <span className="ml-1.5 text-sm text-muted">{SAYS[top.kind]}</span>
      </Row>
      {shown && (
        <Contents
          top={top.id}
          folder={tree}
          depth={1}
          unfolded={unfolded}
          toggle={toggle}
          current={current}
          open={open}
          start={start}
          moved={moved}
        />
      )}
    </div>
  );
}

function Contents({
  top,
  folder,
  depth,
  unfolded,
  toggle,
  current,
  open,
  start,
  moved,
}: {
  top: string;
  folder: Folder;
  depth: number;
  unfolded: (key: string) => boolean;
  toggle: (key: string, open?: boolean) => void;
  current: string | null;
  open: (id: string) => void;
  /** Null where this person may not write. */
  start: ((folder: string) => void) | null;
  moved: () => void;
}) {
  if (folder.folders.length === 0 && folder.pages.length === 0) {
    return (
      <p className="py-1 text-sm text-muted" style={{ paddingLeft: `${depth * 14 + 22}px` }}>
        Empty
      </p>
    );
  }
  return (
    <>
      {folder.folders.map((child) => (
        <Subfolder
          key={child.path}
          top={top}
          folder={child}
          depth={depth}
          unfolded={unfolded}
          toggle={toggle}
          current={current}
          open={open}
          start={start}
          moved={moved}
        />
      ))}
      {folder.pages.map((page) => (
        <button
          type="button"
          key={page.id}
          aria-current={current === page.id ? "page" : undefined}
          className={`block w-full cursor-pointer truncate rounded-md py-1 pr-2 text-left ${current === page.id ? "bg-panel font-medium inset-ring inset-ring-line" : "hover:bg-hover"}`}
          style={{ paddingLeft: `${depth * 14 + 22}px` }}
          title={page.title}
          onClick={() => open(page.id)}
        >
          {page.title}
        </button>
      ))}
    </>
  );
}

function Subfolder({
  top,
  folder,
  depth,
  unfolded,
  toggle,
  current,
  open,
  start,
  moved,
}: {
  top: string;
  folder: Folder;
  depth: number;
  unfolded: (key: string) => boolean;
  toggle: (key: string, open?: boolean) => void;
  current: string | null;
  open: (id: string) => void;
  /** Null where this person may not write. */
  start: ((folder: string) => void) | null;
  moved: () => void;
}) {
  const key = folderKey(top, folder.path);
  const shown = unfolded(key);
  const [renaming, setRenaming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const parent = folder.path.slice(0, Math.max(0, folder.path.length - folder.name.length - 1));

  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name || name === folder.name) return setRenaming(false);
    if (name.includes("/")) return setProblem("A folder's name has no /.");
    const to = parent ? `${parent}/${name}` : name;
    try {
      await api("/folders/move", { body: { top, from: folder.path, to } });
      setRenaming(false);
      setProblem(null);
      toggle(folderKey(top, to), shown);
      moved();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <>
      {renaming ? (
        <form onSubmit={rename} className="py-0.5" style={{ paddingLeft: `${depth * 14 + 8}px` }}>
          <Input
            name="name"
            defaultValue={folder.name}
            aria-label={`New name for ${folder.name}`}
            ref={(element) => element?.focus()}
            onBlur={() => setRenaming(false)}
            onKeyDown={(event) => event.key === "Escape" && setRenaming(false)}
          />
        </form>
      ) : (
        <Row
          depth={depth}
          unfolded={shown}
          onClick={() => toggle(key)}
          actions={
            start && (
              <Actions
                start={() => start(folder.path)}
                add={(child) => start(`${folder.path}/${child}`)}
                rename={() => setRenaming(true)}
              />
            )
          }
        >
          {folder.name}
        </Row>
      )}
      {problem && (
        <p className="text-sm text-problem" style={{ paddingLeft: `${depth * 14 + 22}px` }}>
          {problem}
        </p>
      )}
      {shown && (
        <Contents
          top={top}
          folder={folder}
          depth={depth + 1}
          unfolded={unfolded}
          toggle={toggle}
          current={current}
          open={open}
          start={start}
          moved={moved}
        />
      )}
    </>
  );
}

function Row({
  depth,
  unfolded,
  onClick,
  actions,
  children,
}: {
  depth: number;
  unfolded: boolean;
  onClick: () => void;
  actions: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="group flex items-center rounded-md hover:bg-hover">
      <button
        type="button"
        aria-expanded={unfolded}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 truncate py-1 text-left"
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={onClick}
      >
        <span aria-hidden="true" className="w-2.5 text-xs text-muted">
          {unfolded ? "▾" : "▸"}
        </span>
        <span className="truncate">{children}</span>
      </button>
      <div className="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">{actions}</div>
    </div>
  );
}

/** A folder's buttons: a new page in it, a new folder in it, and renaming it. */
function Actions({ start, add, rename }: { start: () => void; add: (name: string) => void; rename?: () => void }) {
  const [naming, setNaming] = useState(false);
  const small = "h-6 cursor-pointer rounded px-1.5 text-sm text-muted hover:bg-line hover:text-fg";
  if (naming) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
          setNaming(false);
          if (name && !name.includes("/")) add(name);
        }}
      >
        <input
          name="name"
          className="h-6 w-28 rounded border border-line-strong bg-panel px-1.5 text-sm"
          placeholder="Folder name"
          aria-label="New folder's name"
          ref={(element) => element?.focus()}
          onBlur={() => setNaming(false)}
          onKeyDown={(event) => event.key === "Escape" && setNaming(false)}
        />
      </form>
    );
  }
  return (
    <>
      <button type="button" className={small} title="New page here" aria-label="New page here" onClick={start}>
        +
      </button>
      <button
        type="button"
        className={small}
        title="New folder here: it holds its first page once saved"
        aria-label="New folder here"
        onClick={() => setNaming(true)}
      >
        ⊞
      </button>
      {rename && (
        <button type="button" className={small} title="Rename" aria-label="Rename the folder" onClick={rename}>
          ✎
        </button>
      )}
    </>
  );
}

/** Pages matching the words, by meaning as well as by title, with where each sits. */
function Found({
  words,
  pages,
  tops,
  open,
  current,
}: {
  words: string;
  pages: PageRow[];
  tops: Top[];
  open: (id: string) => void;
  current: string | null;
}) {
  const load = useCallback(
    () => api<{ records: RecordRow[] }>(`/records?q=${encodeURIComponent(words)}`).then((answer) => answer.records),
    [words],
  );
  const { data, error } = useLoad(load);
  const shown = new Map(pages.map((page) => [page.id, page]));
  if (error) return <Notice message={error} />;
  if (!data) return <Loading what="pages" />;
  const found = data.map((record) => shown.get(record.id)).filter((page): page is PageRow => page !== undefined);
  if (found.length === 0) return <Empty>No page matches.</Empty>;
  return (
    <ul>
      {found.map((page) => (
        <li key={page.id}>
          <button
            type="button"
            aria-current={current === page.id ? "page" : undefined}
            className={`block w-full cursor-pointer rounded-md px-2 py-1 text-left ${current === page.id ? "bg-panel inset-ring inset-ring-line" : "hover:bg-hover"}`}
            onClick={() => open(page.id)}
          >
            <span className={`block truncate ${current === page.id ? "font-medium" : ""}`}>{page.title}</span>
            <span className="block truncate text-sm text-muted">{placeLabel(tops, page.top, page.folder)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
