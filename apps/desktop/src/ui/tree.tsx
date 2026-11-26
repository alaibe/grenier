import { ChevronRight, type LucideIcon } from "lucide-react";
import { type DragEvent, type KeyboardEvent, type ReactNode, useState } from "react";

export interface TreeNode {
  id: string;
  /** What typing a letter and screen readers go by. */
  name: string;
  /** The title, when it shows more than the name: an input to rename it. */
  title?: ReactNode;
  icon?: LucideIcon;
  /** A top of the tree, named in the label role. */
  group?: boolean;
  meta?: ReactNode;
  /** A second line, in muted: the row is then 56 tall. */
  preview?: ReactNode;
  /** The row's own actions, shown on hover, focus and selection. */
  actions?: ReactNode;
  /** Present for a folder, even an empty one. */
  children?: TreeNode[];
}

interface Shown {
  node: TreeNode;
  depth: number;
  parent: string | null;
}

/** The rows a tree shows, in order: every node whose folders are all open. */
export function visibleRows(
  nodes: TreeNode[],
  open: (id: string) => boolean,
  depth = 0,
  parent: string | null = null,
): Shown[] {
  return nodes.flatMap((node) => [
    { node, depth, parent },
    ...(node.children && open(node.id) ? visibleRows(node.children, open, depth + 1, node.id) : []),
  ]);
}

/** Moving rows by dragging them: what may move, and which row a drop over another lands in. */
export interface TreeDrag {
  can: (node: TreeNode) => boolean;
  /** The folder a drop of `dragged` over `over` goes into, or null where it can't. */
  into: (dragged: string, over: TreeNode) => string | null;
  drop: (dragged: string, into: string) => void;
}

const DRAGGED = "application/x-grenier-tree";

/**
 * Folders and their items as one-line rows (components/row.md): the selected one in accent-soft with its bar, glowing
 * while the tree has focus. J/K or ↓/↑ move, → opens a folder or goes in, ← closes it or goes up, Enter opens.
 */
export function Tree({
  label,
  nodes,
  selected,
  open,
  onSelect,
  onToggle,
  onOpen,
  drag,
}: {
  label: string;
  nodes: TreeNode[];
  selected: string | null;
  open: (id: string) => boolean;
  /** The selection moved to a row, by key or by click. */
  onSelect: (node: TreeNode) => void;
  onToggle: (id: string, open: boolean) => void;
  /** Enter on an item that isn't a folder. */
  onOpen: (node: TreeNode) => void;
  drag?: TreeDrag;
}) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const rows = visibleRows(nodes, open);
  // Without a single folder, the tree is a list.
  const flat = !rows.some((row) => row.node.children);
  const at = rows.findIndex((row) => row.node.id === selected);
  const current = rows[at];

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
    const go = (index: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
      if (row) onSelect(row.node);
    };
    const key = event.key;
    if (key === "ArrowDown" || key === "j") go(at + 1);
    else if (key === "ArrowUp" || key === "k") go(at < 0 ? 0 : at - 1);
    else if (key === "Home") go(0);
    else if (key === "End") go(rows.length - 1);
    else if (key === "ArrowRight" && current?.node.children) {
      if (!open(current.node.id)) onToggle(current.node.id, true);
      else go(at + 1);
    } else if (key === "ArrowLeft" && current) {
      if (current.node.children && open(current.node.id)) onToggle(current.node.id, false);
      else go(rows.findIndex((row) => row.node.id === current.parent));
    } else if (key === "Enter" && current) {
      if (current.node.children) onToggle(current.node.id, !open(current.node.id));
      else onOpen(current.node);
    } else if (key.length === 1 && /\S/.test(key)) {
      const letter = key.toLowerCase();
      const after = rows.slice(at + 1).concat(rows.slice(0, at + 1));
      const found = after.find((row) => row.node.name.toLowerCase().startsWith(letter));
      if (!found) return;
      onSelect(found.node);
    } else return;
    event.preventDefault();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a tree or a listbox, by its role
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a tree or a listbox, by its role
    <div
      className="list"
      role={flat ? "listbox" : "tree"}
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={current ? `tree-${current.node.id}` : undefined}
      onKeyDown={keyDown}
    >
      {rows.map(({ node, depth }) => {
        const folder = node.children !== undefined;
        const unfolded = folder && open(node.id);
        const Glyph = node.icon;
        const draggable = drag?.can(node) ?? false;
        const over = (event: DragEvent<HTMLDivElement>) => {
          const into = dragged && drag ? drag.into(dragged, node) : null;
          if (into === null) return setTarget(null);
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setTarget(into);
        };
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: a treeitem or an option, by its role
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a treeitem or an option, by its role
          <div
            key={node.id}
            id={`tree-${node.id}`}
            className={node.preview ? "row" : "row row-one"}
            role={flat ? "option" : "treeitem"}
            aria-level={flat ? undefined : depth + 1}
            aria-selected={node.id === selected}
            aria-expanded={folder ? unfolded : undefined}
            data-drop={node.id === target || undefined}
            draggable={draggable || undefined}
            onDragStart={
              draggable
                ? (event) => {
                    event.dataTransfer.setData(DRAGGED, node.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDragged(node.id);
                  }
                : undefined
            }
            onDragEnd={() => {
              setDragged(null);
              setTarget(null);
            }}
            onDragOver={drag ? over : undefined}
            onDrop={
              drag
                ? (event) => {
                    setDragged(null);
                    setTarget(null);
                    if (!dragged || !target) return;
                    event.preventDefault();
                    drag.drop(dragged, target);
                  }
                : undefined
            }
            style={{ paddingLeft: `calc(var(--space-3) + ${depth} * var(--space-4))` }}
            onClick={(event) => {
              if ((event.target as Element).closest("button, input, a")) return;
              onSelect(node);
              if (folder) onToggle(node.id, !unfolded);
              else onOpen(node);
            }}
            onKeyDown={() => {}}
          >
            <span className="row-lead text-muted">
              {folder ? (
                <ChevronRight
                  className={`icon size-3 transition-transform duration-120 ${unfolded ? "rotate-90" : ""}`}
                  aria-hidden="true"
                />
              ) : (
                Glyph && <Glyph className="icon" aria-hidden="true" />
              )}
            </span>
            {node.group ? (
              <span className="label self-center truncate" style={{ gridArea: "title" }}>
                {node.title ?? node.name}
              </span>
            ) : (
              <span className="row-title">{node.title ?? node.name}</span>
            )}
            <span className="row-meta flex items-center gap-2">
              {node.meta}
              {node.actions && <span className="row-actions">{node.actions}</span>}
            </span>
            {node.preview && <span className="row-preview">{node.preview}</span>}
          </div>
        );
      })}
    </div>
  );
}
