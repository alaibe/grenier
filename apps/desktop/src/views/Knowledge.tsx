import type { PageRow, RecordRow, Top } from "@grenier/core/api";
import { topName } from "@grenier/core/team";
import { FilePlus, FileText, FolderPlus, Pencil } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { ListDetail } from "../shell/regions.tsx";
import { IconButton } from "../ui/button.tsx";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { Input, SearchField } from "../ui/field.tsx";
import { useLoad } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Tree, type TreeNode, visibleRows } from "../ui/tree.tsx";
import { type FolderPath, folderPath, PageEditor, type Target } from "./PageEditor.tsx";

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

/** A folder's node id; a top folder's ends with "/", as its path is empty. */
const folderId = (top: string, path: string) => `${top}/${path}`;
const pageId = (id: string) => `page:${id}`;
const pageOf = (node: TreeNode) => (node.id.startsWith("page:") ? node.id.slice(5) : null);
const isTop = (id: string) => id.endsWith("/");

/** Whether a folder shows what it holds: top folders start open, the rest folded. Kept in this window only. */
function useFolding(): [(id: string) => boolean, (id: string, open: boolean) => void] {
  const [flipped, setFlipped] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOLDING_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const unfolded = useCallback((id: string) => flipped.has(id) !== isTop(id), [flipped]);
  const fold = useCallback((id: string, open: boolean) => {
    setFlipped((current) => {
      if ((current.has(id) !== isTop(id)) === open) return current;
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(FOLDING_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, []);
  return [unfolded, fold];
}

const ORDER: Record<Top["kind"], number> = { me: 0, team: 1, repo: 2, custom: 3 };

const SAYS: Record<Top["kind"], string> = {
  me: "only you",
  team: "everyone",
  repo: "repository",
  custom: "some members",
};

/** Where a new page goes when nothing says: Me for a member, Team for an admin. */
function firstFolder(tops: Top[], member: boolean): Target | null {
  const top =
    tops.find((entry) => entry.kind === (member ? "me" : "team")) ?? tops.find((entry) => entry.kind === "me");
  return top ? { top: top.id, folder: "" } : null;
}

export function Knowledge({ item, go, changed, member }: ViewProps) {
  const tops = useLoad(loadTops);
  const pages = useLoad(loadPages);
  const [unfolded, fold] = useFolding();
  const [words, setWords] = useState("");
  const [cursor, setCursor] = useState<string | null>(item && item !== "new" ? pageId(item) : null);
  const [newIn, setNewIn] = useState<Target | null>(null);
  const [editing, setEditing] = useState<{ id: string; kind: "rename" | "folder" } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const searching = words.trim().length >= 2;

  const open = useCallback((id: string) => go("knowledge", id), [go]);
  const reload = () => {
    pages.reload();
    changed();
  };

  const sorted = useMemo(
    () =>
      [...(tops.data ?? [])]
        .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || byName.compare(a.name, b.name))
        .map((top) => ({ top, tree: treeOf((pages.data ?? []).filter((page) => page.top === top.id)) })),
    [tops.data, pages.data],
  );
  const folderPaths: FolderPath[] = useMemo(
    () =>
      sorted.flatMap(({ top, tree }) =>
        ["", ...foldersIn(tree)].map((folder) => ({
          top: top.id,
          folder,
          label: folderPath(tops.data ?? [], top.id, folder),
        })),
      ),
    [sorted, tops.data],
  );

  const writes = (top: Top) => !member || top.kind === "me";
  const startPage = useCallback(
    (target: Target) => {
      setNewIn(target);
      go("knowledge", "new");
    },
    [go],
  );

  // A page opened from elsewhere shows where it sits, and is the selected row.
  useEffect(() => {
    if (!item || item === "new") return;
    setCursor(pageId(item));
    const page = pages.data?.find((entry) => entry.id === item);
    if (!page) return;
    fold(folderId(page.top, ""), true);
    const names = page.folder ? page.folder.split("/") : [];
    for (let depth = 1; depth <= names.length; depth++) fold(folderId(page.top, names.slice(0, depth).join("/")), true);
  }, [item, pages.data, fold]);

  const rename = async (top: string, from: Folder, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    setEditing(null);
    if (!name || name === from.name) return;
    if (name.includes("/")) return setProblem("A folder's name has no /. Name it again without one.");
    const parent = from.path.slice(0, Math.max(0, from.path.length - from.name.length - 1));
    const to = parent ? `${parent}/${name}` : name;
    try {
      await api("/folders/move", { body: { top, from: from.path, to } });
      setProblem(null);
      fold(folderId(top, to), unfolded(folderId(top, from.path)));
      reload();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  const naming = (
    id: string,
    defaultValue: string,
    label: string,
    done: (event: FormEvent<HTMLFormElement>) => void,
  ) => (
    <form onSubmit={done}>
      <Input
        name="name"
        defaultValue={defaultValue}
        aria-label={label}
        placeholder="Folder name"
        ref={(element) => element?.focus()}
        onBlur={() => setEditing(null)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          setEditing(null);
          document.getElementById(`tree-${id}`)?.closest<HTMLElement>("[role=tree]")?.focus();
        }}
      />
    </form>
  );

  const folderActions = (top: Top, folder: Folder) => {
    if (!writes(top)) return undefined;
    const id = folderId(top.id, folder.path);
    return (
      <>
        <IconButton
          label="New page here"
          icon={FilePlus}
          size="sm"
          onClick={() => startPage({ top: top.id, folder: folder.path })}
        />
        <IconButton
          label="New folder here: it holds its first page once saved"
          icon={FolderPlus}
          size="sm"
          onClick={() => {
            fold(id, true);
            setEditing({ id, kind: "folder" });
          }}
        />
        {folder.path && (
          <IconButton label="Rename" icon={Pencil} size="sm" onClick={() => setEditing({ id, kind: "rename" })} />
        )}
      </>
    );
  };

  const nodesOf = (top: Top, folder: Folder): TreeNode[] => {
    const id = folderId(top.id, folder.path);
    const adding: TreeNode[] =
      editing?.id === id && editing.kind === "folder"
        ? [
            {
              id: `${id}+`,
              name: "",
              icon: FolderPlus,
              title: naming(id, "", "New folder's name", (event) => {
                event.preventDefault();
                const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
                setEditing(null);
                if (name && !name.includes("/"))
                  startPage({ top: top.id, folder: folder.path ? `${folder.path}/${name}` : name });
              }),
            },
          ]
        : [];
    return [
      ...adding,
      ...folder.folders.map((child) => {
        const childId = folderId(top.id, child.path);
        const renaming = editing?.id === childId && editing.kind === "rename";
        return {
          id: childId,
          name: child.name,
          ...(renaming
            ? {
                title: naming(childId, child.name, `New name for ${child.name}`, (event) => {
                  void rename(top.id, child, event);
                }),
              }
            : {}),
          actions: folderActions(top, child),
          children: nodesOf(top, child),
        };
      }),
      ...folder.pages.map((page) => ({ id: pageId(page.id), name: page.title, icon: FileText })),
    ];
  };

  const nodes: TreeNode[] = sorted.map(({ top, tree }) => ({
    id: folderId(top.id, ""),
    name: topName(top),
    group: true,
    meta: SAYS[top.kind],
    actions: folderActions(top, tree),
    children: nodesOf(top, tree),
  }));

  const rows = visibleRows(nodes, unfolded);
  const fallback = firstFolder(tops.data ?? [], member);
  const commands = useMemo<Command[]>(() => {
    const move = (by: number) => {
      const at = rows.findIndex((row) => row.node.id === cursor);
      const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + by))];
      if (!next) return;
      setCursor(next.node.id);
      const page = pageOf(next.node);
      if (page) open(page);
    };
    return [
      {
        id: "knowledge.search",
        label: "Search the pages",
        keys: "/",
        also: ["mod+f"],
        hint: { in: "list", says: "search", order: 30 },
        run: () => search.current?.focus(),
      },
      ...(fallback
        ? [
            {
              id: "new-page",
              label: "New page",
              icon: FilePlus,
              keys: "n",
              also: ["mod+n"],
              hint: { in: "list" as const, says: "new", order: 20 },
              run: () => startPage(fallback),
            },
          ]
        : []),
      {
        id: "knowledge.next",
        label: "Next page",
        keys: "j",
        also: ["arrowdown"],
        hidden: true,
        hint: { in: "list", says: "move", keys: "j+k", order: 10 },
        run: () => move(1),
      },
      {
        id: "knowledge.previous",
        label: "Previous page",
        keys: "k",
        also: ["arrowup"],
        hidden: true,
        run: () => move(-1),
      },
      ...(item
        ? [
            {
              id: "knowledge.close",
              label: "Close the page",
              keys: "escape",
              hidden: true,
              hint: { in: "item" as const, says: "close", order: 40 },
              run: () => go("knowledge"),
            },
          ]
        : []),
    ];
  }, [rows, cursor, open, fallback, item, startPage, go]);
  useCommands(commands);

  const target: Target | null = item === "new" ? (newIn ?? fallback) : item ? { id: item } : null;

  const list = (
    <>
      <div className="border-b border-line p-3">
        <SearchField
          ref={search}
          label="Search the pages"
          placeholder="Search pages"
          live
          value={words}
          onChange={(event) => setWords(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            event.currentTarget
              .closest("[data-region]")
              ?.querySelector<HTMLElement>("[role=tree], [role=listbox]")
              ?.focus();
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Problem error={tops.error ?? pages.error ?? problem} />
        {!tops.data || !pages.data ? (
          <Skeleton rows={8} />
        ) : searching ? (
          <Found words={words.trim()} pages={pages.data} tops={tops.data} current={item ?? null} open={open} />
        ) : (
          <Tree
            label="Pages"
            nodes={nodes}
            selected={cursor}
            open={unfolded}
            onSelect={(node) => {
              setCursor(node.id);
              const page = pageOf(node);
              if (page) open(page);
            }}
            onToggle={fold}
            onOpen={(node) => {
              const page = pageOf(node);
              if (page) open(page);
            }}
          />
        )}
      </div>
    </>
  );

  return (
    <ListDetail title="Knowledge" list={list}>
      {target && tops.data ? (
        <PageEditor
          key={"id" in target ? target.id : `new:${target.top}:${target.folder}`}
          target={target}
          folderPaths={folderPaths}
          tops={tops.data}
          member={member}
          open={open}
          changed={reload}
          closed={() => go("knowledge")}
        />
      ) : (
        <Empty boot={pages.data?.length === 0 ? "no pages yet" : "pick a page"}>
          {pages.data?.length === 0
            ? "What you and your agents learn lands here. Start a page with N."
            : "Open one from the list, or start a page with N."}
        </Empty>
      )}
    </ListDetail>
  );
}

/** Pages matching the words, by meaning as well as by title, each with where it sits. */
function Found({
  words,
  pages,
  tops,
  current,
  open,
}: {
  words: string;
  pages: PageRow[];
  tops: Top[];
  current: string | null;
  open: (id: string) => void;
}) {
  const load = useCallback(
    () => api<{ records: RecordRow[] }>(`/records?q=${encodeURIComponent(words)}`).then((answer) => answer.records),
    [words],
  );
  const { data, error } = useLoad(load);
  const [cursor, setCursor] = useState<string | null>(current ? pageId(current) : null);
  if (error) return <Problem error={error} />;
  if (!data) return <Skeleton rows={4} />;
  const shown = new Map(pages.map((page) => [page.id, page]));
  const found = data.map((record) => shown.get(record.id)).filter((page): page is PageRow => page !== undefined);
  if (found.length === 0) {
    return (
      <Empty boot="no match" match>
        No page holds “{words}”. Try fewer words, or other ones.
      </Empty>
    );
  }
  return (
    <Tree
      label="Pages found"
      nodes={found.map((page) => ({
        id: pageId(page.id),
        name: page.title,
        icon: FileText,
        preview: folderPath(tops, page.top, page.folder),
      }))}
      selected={cursor}
      open={() => false}
      onSelect={(node) => {
        setCursor(node.id);
        const page = pageOf(node);
        if (page) open(page);
      }}
      onToggle={() => {}}
      onOpen={(node) => {
        const page = pageOf(node);
        if (page) open(page);
      }}
    />
  );
}
