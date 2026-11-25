import { useCallback, useEffect, useState } from "react";
import { Mark } from "../ui.tsx";
import { SCREENS, type ViewName } from "../usage/screens.ts";
import { PLACE_ICONS, PLACES } from "./places.ts";

const SIDEBAR = { key: "grenier.sidebar", width: 232, min: 200, max: 320, folded: 48 };

/** Below this width the sidebar folds to icons on its own. */
const NARROW = 1100;

function saved(): { width: number; collapsed: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(SIDEBAR.key) ?? "{}");
    const width = Number(value.width);
    return {
      width: width >= SIDEBAR.min && width <= SIDEBAR.max ? width : SIDEBAR.width,
      collapsed: value.collapsed === true,
    };
  } catch {
    return { width: SIDEBAR.width, collapsed: false };
  }
}

/** The sidebar's width and whether it is folded, kept between launches; it folds on its own in a narrow window. */
export function useSidebar() {
  const [state, setState] = useState(saved);
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR.key, JSON.stringify(state));
    } catch {}
  }, [state]);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const collapsed = state.collapsed || narrow;
  return {
    collapsed,
    width: collapsed ? SIDEBAR.folded : state.width,
    toggle: useCallback(() => setState((value) => ({ ...value, collapsed: !value.collapsed })), []),
    resize: useCallback((width: number) => setState((value) => ({ ...value, width })), []),
    reset: useCallback(() => setState((value) => ({ ...value, width: SIDEBAR.width })), []),
  };
}

/** The app's places: an icon and a name each, or the icon alone when folded, with what waits as a count. */
export function Sidebar({
  current,
  go,
  collapsed,
  counts,
  onResize,
  onReset,
  ref,
}: {
  current: ViewName;
  go: (view: ViewName) => void;
  collapsed: boolean;
  /** A count beside a place, with what it counts. */
  counts: Partial<Record<ViewName, { value: number; title: string }>>;
  onResize: (width: number) => void;
  onReset: () => void;
  ref: React.Ref<HTMLElement>;
}) {
  return (
    <nav
      ref={ref}
      className="relative flex min-h-0 flex-col gap-0.5 overflow-x-hidden overflow-y-auto border-r border-line bg-side px-2 py-3"
      aria-label="Places"
    >
      <p
        className={`mb-3 flex items-center gap-2 font-mono text-sm font-semibold ${collapsed ? "justify-center" : "mx-2"}`}
      >
        <Mark />
        {!collapsed && "Grenier"}
      </p>
      {PLACES.map((name, index) => {
        const Icon = PLACE_ICONS[name];
        const count = counts[name];
        return (
          <button
            type="button"
            key={name}
            title={collapsed ? `${SCREENS[name].title}  ⌘${index + 1}` : undefined}
            aria-label={collapsed ? SCREENS[name].title : undefined}
            aria-current={current === name ? "page" : undefined}
            onClick={() => go(name)}
            className={`flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left font-mono text-sm font-medium whitespace-nowrap ${collapsed ? "justify-center" : ""} ${current === name ? "bg-accent-soft text-fg" : "text-fg hover:bg-hover"}`}
          >
            <Icon
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              className={current === name ? "text-accent" : "text-muted"}
            />
            {!collapsed && <span className="flex-1">{SCREENS[name].title}</span>}
            {!collapsed && count && count.value > 0 && (
              <span className="font-mono text-xs text-accent tabular-nums" title={count.title}>
                {count.value}
              </span>
            )}
          </button>
        );
      })}
      {!collapsed && <Resizer min={SIDEBAR.min} max={SIDEBAR.max} onResize={onResize} onReset={onReset} />}
    </nav>
  );
}

/** A region's right edge: drag to resize between `min` and `max`, double-click to reset. */
export function Resizer({
  min,
  max,
  onResize,
  onReset,
}: {
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable edge, which an <hr> can't be
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize"
      className="group absolute inset-y-0 right-0 w-1 cursor-col-resize"
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        const edge = event.currentTarget;
        edge.setPointerCapture(event.pointerId);
        const left = edge.parentElement?.getBoundingClientRect().left ?? 0;
        const move = (next: PointerEvent) => onResize(Math.round(Math.max(min, Math.min(max, next.clientX - left))));
        const stop = () => {
          edge.removeEventListener("pointermove", move);
          edge.removeEventListener("pointerup", stop);
        };
        edge.addEventListener("pointermove", move);
        edge.addEventListener("pointerup", stop);
      }}
    >
      <span className="absolute inset-y-0 right-0 w-px bg-accent opacity-0 group-hover:opacity-100" />
    </div>
  );
}
