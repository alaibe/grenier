import { useCallback, useEffect, useState } from "react";
import { Mark } from "../ui/brand.tsx";
import { spoken } from "../ui/keys.ts";
import { SCREENS, type ViewName } from "../usage/screens.ts";
import { PLACE_ICONS, PLACES, placeKeys } from "./places.ts";
import { Resizer } from "./regions.tsx";
import { href } from "./router.ts";

const SIDEBAR = { key: "grenier.sidebar", width: 232, min: 200, max: 320, folded: 48 };

/** Below this width the sidebar folds to icons on its own (foundations/layout.md#breakpoints). */
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

export interface Count {
  value: number;
  /** What it counts, for its tooltip. */
  title: string;
  /** Something arrived since the person last looked: the count lights up. */
  news?: boolean;
}

/** The app's places (components/sidebar.md): its icon and name on top, the places, Settings at the bottom. */
export function Sidebar({
  current,
  go,
  collapsed,
  width,
  counts,
  onResize,
  onReset,
}: {
  current: ViewName;
  go: (place: ViewName) => void;
  collapsed: boolean;
  width: number;
  counts: Partial<Record<ViewName, Count>>;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const item = (name: ViewName) => {
    const Icon = PLACE_ICONS[name];
    const count = counts[name];
    const title = SCREENS[name].title;
    return (
      <a
        key={name}
        href={href({ place: name })}
        className={`sidebar-item${collapsed ? " justify-center" : ""}`}
        aria-current={current === name ? "page" : undefined}
        data-news={count?.news || undefined}
        title={collapsed ? title : undefined}
        data-keys={collapsed ? placeKeys(name) : undefined}
        aria-label={collapsed ? title : undefined}
        aria-keyshortcuts={spoken(placeKeys(name))}
        onClick={(event) => {
          event.preventDefault();
          go(name);
        }}
      >
        <Icon className="icon" aria-hidden="true" />
        {!collapsed && title}
        {!collapsed && count && count.value > 0 && (
          <span className="sidebar-count" title={count.title}>
            {count.value}
          </span>
        )}
      </a>
    );
  };
  return (
    <nav className="sidebar" aria-label="Places" data-region="sidebar" style={{ width }}>
      <div className={`sidebar-app${collapsed ? " justify-center px-0" : ""}`}>
        <Mark />
        {!collapsed && "Grenier"}
      </div>
      <div className="flex flex-col gap-0.5">{PLACES.map(item)}</div>
      <div className="mt-auto flex flex-col gap-0.5 pt-4">{item("settings")}</div>
      {!collapsed && <Resizer min={SIDEBAR.min} max={SIDEBAR.max} onResize={onResize} onReset={onReset} />}
    </nav>
  );
}
