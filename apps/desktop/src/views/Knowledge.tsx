import type { PageRow, Top } from "@grenier/core/api";
import { topName } from "@grenier/core/team";
import { FilePlus, FileText, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { ListDetail } from "../shell/regions.tsx";
import { IconButton } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { Input } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Tree, type TreeDrag, type TreeNode, useFolding, visibleRows } from "../ui/tree.tsx";
import { Found } from "./KnowledgeFound.tsx";
import {
  type Folder,
  folderId,
  foldersIn,
  holds,
  isTop,
  pageId,
  pageOf,
  parentOf,
  treeOf,
  useEmptyFolders,
} from "./knowledge-tree.ts";
import { useListSearch } from "./list-search.tsx";
import { type FolderPath, folderPath, PageEditor, type Target } from "./PageEditor.tsx";

const loadTops = () => api<{ tops: Top[] }>("/tops").then((answer) => answer.tops);
const loadPages = () => api<{ pages: PageRow[] }>("/pages").then((answer) => answer.pages);

const NO_SLASH = "A folder's name has no /. Name it again without one.";

const FOLDING_KEY = "grenier.knowledge.folding";
/** A row dragged onto a folder: both by their tree ids. */
interface Moving {
  dragged: string;
  into: string;
}

/** A move into another top folder, waiting for the person's yes. */
interface Crossing extends Moving {
  from: Top;
  to: Top;
  name: string;
}

const SAYS: Record<Top["id"], string> = { me: "only you", team: "everyone" };

/** Where a new page goes when nothing says: Me for a member, Team for an admin. */
function firstFolder(tops: Top[], member: boolean): Target | null {
  const top = tops.find((entry) => entry.id === (member ? "me" : "team")) ?? tops.find((entry) => entry.id === "me");
  return top ? { top: top.id, folder: "" } : null;
}

export function Knowledge({ item, go, changed, member }: ViewProps) {
  const tops = useLoad(loadTops);
  const pages = useLoad(loadPages);
  const [unfolded, fold] = useFolding((id) => !isTop(id), FOLDING_KEY);
  const emptyFolders = useEmptyFolders(pages.data);
  const [cursor, setCursor] = useState<string | null>(item && item !== "new" ? pageId(item) : null);
  const [newIn, setNewIn] = useState<Target | null>(null);
  const [editing, setEditing] = useState<{ id: string; kind: "rename" | "folder" } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [crossing, setCrossing] = useState<Crossing | null>(null);
  const { field: searchField, words } = useListSearch("knowledge.search", "Search the pages", "Search pages");
  const searching = words.trim().length >= 2;

  const open = useCallback((id: string) => go("knowledge", id), [go]);
  const reload = () => {
    pages.reload();
    changed();
  };

  const sorted = useMemo(
    () =>
      (tops.data ?? []).map((top) => ({
        top,
        tree: treeOf(
          (pages.data ?? []).filter((page) => page.top === top.id),
          emptyFolders.empty.filter((id) => id.startsWith(`${top.id}/`)).map((id) => id.slice(top.id.length + 1)),
        ),
      })),
    [tops.data, pages.data, emptyFolders.empty],
  );
  const folderPaths: FolderPath[] = useMemo(
    () =>
      sorted.flatMap(({ top, tree }) =>
        ["", ...foldersIn(tree)].map((folder) => ({
          top: top.id,
          folder,
          label: folderPath(top.id, folder),
        })),
      ),
    [sorted],
  );

  const writes = (top: Top) => !member || top.id === "me";
  const moving = useAction(reload);
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

  /** Moves a folder and every page under it, the empty folders it holds, and whether it shows them. */
  const moveFolder = async (top: string, from: string, toTop: string, to: string) => {
    await api("/folders/move", { body: { top, from, to, toTop } });
    emptyFolders.move(top, from, toTop, to);
    fold(folderId(toTop, to), unfolded(folderId(top, from)));
  };

  const rename = async (top: string, from: Folder, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    setEditing(null);
    if (!name || name === from.name) return;
    if (name.includes("/")) return setProblem(NO_SLASH);
    const parent = parentOf(from.path);
    const to = parent ? `${parent}/${name}` : name;
    try {
      await moveFolder(top, from.path, top, to);
      setProblem(null);
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
          label="New folder here"
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
        {folder.path && !holds(folder) && (
          <IconButton
            label="Remove this empty folder"
            icon={Trash2}
            size="sm"
            onClick={() => emptyFolders.remove(top.id, folder.path)}
          />
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
                if (!name) return;
                if (name.includes("/")) return setProblem(NO_SLASH);
                const path = folder.path ? `${folder.path}/${name}` : name;
                emptyFolders.add(top.id, path);
                fold(folderId(top.id, path), true);
                setCursor(folderId(top.id, path));
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
    name: topName(top.id),
    group: true,
    meta: SAYS[top.id],
    actions: folderActions(top, tree),
    children: nodesOf(top, tree),
  }));

  /** Each folder row's top folder and path, by its id. */
  const places = useMemo(() => {
    const out = new Map<string, { top: Top; path: string; name: string }>();
    for (const { top, tree } of sorted) {
      const add = (folder: Folder) => {
        out.set(folderId(top.id, folder.path), { top, path: folder.path, name: folder.name || topName(top.id) });
        folder.folders.forEach(add);
      };
      add(tree);
    }
    return out;
  }, [sorted]);
  const byId = useMemo(() => new Map((pages.data ?? []).map((page) => [pageId(page.id), page])), [pages.data]);
  const pageRow = (id: string) => byId.get(id);
  const topOf = (id: string) => {
    const top = pageRow(id)?.top;
    return top ? tops.data?.find((entry) => entry.id === top) : places.get(id)?.top;
  };

  const run = ({ dragged, into }: Moving) => {
    const place = places.get(into);
    if (!place) return;
    const page = pageRow(dragged);
    const from = places.get(dragged);
    void moving.run("move", async () => {
      if (page) {
        await api(`/records/${encodeURIComponent(page.id)}`, {
          method: "PUT",
          body: { top: place.top.id, folder: place.path },
        });
        return `Moved ${page.title} to ${folderPath(place.top.id, place.path)}`;
      }
      if (!from) return undefined;
      await moveFolder(from.top.id, from.path, place.top.id, place.path ? `${place.path}/${from.name}` : from.name);
      return `Moved ${from.name} to ${folderPath(place.top.id, place.path)}`;
    });
  };

  const drag: TreeDrag = {
    can: (node) => {
      const page = pageRow(node.id);
      if (page) return tops.data?.some((top) => top.id === page.top && writes(top)) ?? false;
      const place = places.get(node.id);
      return place !== undefined && place.path !== "" && writes(place.top) && editing === null;
    },
    into: (dragged, over) => {
      const page = pageRow(over.id);
      const into = page ? folderId(page.top, page.folder) : over.id;
      const place = places.get(into);
      if (!place || !writes(place.top)) return null;
      const moved = pageRow(dragged);
      if (moved) return moved.top === place.top.id && moved.folder === place.path ? null : into;
      const from = places.get(dragged);
      if (!from) return null;
      if (from.top.id === place.top.id) {
        if (place.path === parentOf(from.path) || place.path === from.path || place.path.startsWith(`${from.path}/`))
          return null;
      }
      return into;
    },
    drop: (dragged, into) => {
      const to = places.get(into)?.top;
      const from = topOf(dragged);
      const name = pageRow(dragged)?.title ?? places.get(dragged)?.name ?? "";
      // Into another top folder, other people see it, or no longer do: that is asked first.
      if (to && from && from.id !== to.id) setCrossing({ dragged, into, from, to, name });
      else run({ dragged, into });
    },
  };

  const rows = visibleRows(nodes, unfolded);
  const fallback = firstFolder(tops.data ?? [], member);
  // j and k read the rows and the cursor as they are when pressed: the commands change only with what they offer.
  const now = useRef({ rows, cursor, fallback });
  now.current = { rows, cursor, fallback };
  const canAdd = fallback !== null;
  const commands = useMemo<Command[]>(() => {
    const move = (by: number) => {
      const { rows, cursor } = now.current;
      const at = rows.findIndex((row) => row.node.id === cursor);
      const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + by))];
      if (!next) return;
      setCursor(next.node.id);
      const page = pageOf(next.node);
      // Moving through the pages is one place in the history, not one per page.
      if (page) go("knowledge", page, { replace: true });
    };
    return [
      ...(canAdd
        ? [
            {
              id: "new-page",
              label: "New page",
              icon: FilePlus,
              keys: "n",
              also: ["mod+n"],
              hint: { in: "list" as const, says: "new", order: 20 },
              run: () => {
                if (now.current.fallback) startPage(now.current.fallback);
              },
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
  }, [canAdd, item, startPage, go]);
  useCommands(commands);

  const target: Target | null = item === "new" ? (newIn ?? fallback) : item ? { id: item } : null;

  const list = (
    <>
      {searchField}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Problem
          error={tops.error ?? pages.error ?? problem ?? moving.problem}
          retry={
            tops.error || pages.error
              ? () => {
                  tops.reload();
                  pages.reload();
                }
              : undefined
          }
        />
        {!tops.data || !pages.data ? (
          <Skeleton rows={8} />
        ) : searching ? (
          <Found words={words.trim()} pages={pages.data} current={item ?? null} open={open} />
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
            drag={drag}
          />
        )}
        {crossing && (
          <Dialog
            title={`Move to ${topName(crossing.to.id)}?`}
            action="Move"
            onCancel={() => setCrossing(null)}
            onAction={() => {
              setCrossing(null);
              run(crossing);
            }}
          >
            <p>
              {crossing.name} moves from {topName(crossing.from.id)} ({SAYS[crossing.from.id]}) to{" "}
              {topName(crossing.to.id)} ({SAYS[crossing.to.id]}): who can see it changes.
            </p>
          </Dialog>
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
