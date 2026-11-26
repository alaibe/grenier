import type { PageRow } from "@grenier/core/api";
import { useCallback, useEffect, useState } from "react";
import { store, stored } from "../storage.ts";
import type { TreeNode } from "../ui/tree.tsx";

export interface Folder {
  name: string;
  /** "Decisions/2026"; empty for a top folder. */
  path: string;
  folders: Folder[];
  pages: PageRow[];
}

export const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** One top folder's tree, with the empty folders made here: folders first, then pages, each by name. */
export function treeOf(pages: PageRow[], empty: string[]): Folder {
  const top: Folder = { name: "", path: "", folders: [], pages: [] };
  const ensure = (path: string) => {
    let folder = top;
    for (const name of path ? path.split("/") : []) {
      const at = folder.path ? `${folder.path}/${name}` : name;
      let next = folder.folders.find((entry) => entry.name === name);
      if (!next) {
        next = { name, path: at, folders: [], pages: [] };
        folder.folders.push(next);
      }
      folder = next;
    }
    return folder;
  };
  for (const page of pages) ensure(page.folder).pages.push(page);
  empty.forEach(ensure);
  const sort = (folder: Folder) => {
    folder.folders.sort((a, b) => byName.compare(a.name, b.name));
    folder.pages.sort((a, b) => byName.compare(a.title, b.title));
    folder.folders.forEach(sort);
  };
  sort(top);
  return top;
}

/** The path of the folder a folder sits in: "" for one at the top. */
export const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Whether a folder holds a page, itself or in a folder under it. */
export const holds = (folder: Folder): boolean => folder.pages.length > 0 || folder.folders.some(holds);

export function foldersIn(folder: Folder): string[] {
  return folder.folders.flatMap((child) => [child.path, ...foldersIn(child)]);
}

export const EMPTY_KEY = "grenier.knowledge.empty";

/** Folders made here that hold no page yet, as "top/path": the store only knows a folder by its pages. */
export function useEmptyFolders(pages: PageRow[] | null) {
  const [empty, setEmpty] = useState<string[]>(() => stored(EMPTY_KEY, []));
  const keep = useCallback((next: (current: string[]) => string[]) => {
    setEmpty((current) => {
      const value = next(current);
      if (value.length === current.length && value.every((id, at) => id === current[at])) return current;
      store(EMPTY_KEY, value);
      return value;
    });
  }, []);
  // A folder that now holds a page, or a folder under it, no longer needs keeping.
  useEffect(() => {
    if (!pages) return;
    keep((current) =>
      current.filter((id) => {
        const inside = (page: PageRow) => {
          const at = `${page.top}/${page.folder}`;
          return at === id || at.startsWith(`${id}/`);
        };
        return !pages.some(inside) && !current.some((other) => other.startsWith(`${id}/`));
      }),
    );
  }, [pages, keep]);
  return {
    empty,
    add: useCallback((top: string, path: string) => keep((current) => [...current, `${top}/${path}`]), [keep]),
    remove: useCallback(
      (top: string, path: string) =>
        keep((current) => current.filter((id) => id !== `${top}/${path}` && !id.startsWith(`${top}/${path}/`))),
      [keep],
    ),
    /** After a folder's move: the empty folders it held move with it. */
    move: useCallback(
      (top: string, from: string, toTop: string, to: string) =>
        keep((current) =>
          current.map((id) =>
            id === `${top}/${from}` || id.startsWith(`${top}/${from}/`)
              ? `${toTop}/${to}${id.slice(top.length + 1 + from.length)}`
              : id,
          ),
        ),
      [keep],
    ),
  };
}

/** A folder's node id; a top folder's ends with "/", as its path is empty. */
export const folderId = (top: string, path: string) => `${top}/${path}`;

export const pageId = (id: string) => `page:${id}`;

export const pageOf = (node: TreeNode) => (node.id.startsWith("page:") ? node.id.slice(5) : null);

export const isTop = (id: string) => id.endsWith("/");
