import { Mark } from "../ui/brand.tsx";
import { spoken } from "../ui/keys.ts";
import { SCREENS, type ViewName } from "../usage/screens.ts";
import { PLACE_ICONS, PLACES, placeKeys } from "./places.ts";
import { href } from "./router.ts";

export interface Count {
  value: number;
  /** What it counts, for its name and tooltip. */
  title: string;
  /** Something arrived since the person last looked: the badge lights up. */
  news?: boolean;
}

/** The app's places as a rail of icons (components/sidebar.md): names and counts in tooltips, Settings at the bottom. */
export function Sidebar({
  current,
  go,
  counts,
}: {
  current: ViewName;
  go: (place: ViewName) => void;
  counts: Partial<Record<ViewName, Count>>;
}) {
  const item = (name: ViewName) => {
    const Icon = PLACE_ICONS[name];
    const count = counts[name];
    const shown = count && count.value > 0 ? count : null;
    const title = SCREENS[name].title;
    return (
      <a
        key={name}
        href={href({ place: name })}
        className="sidebar-item badge-host"
        aria-current={current === name ? "page" : undefined}
        aria-label={shown ? `${title}, ${shown.title}` : title}
        aria-keyshortcuts={spoken(placeKeys(name))}
        title={shown ? `${title} ${shown.value}` : title}
        data-tip-side="end"
        data-keys={placeKeys(name)}
        onClick={(event) => {
          event.preventDefault();
          go(name);
        }}
      >
        <Icon className="icon" aria-hidden="true" />
        {shown && (
          <span className={shown.news ? "badge" : "badge badge-info"} aria-hidden="true">
            {shown.value}
          </span>
        )}
      </a>
    );
  };
  return (
    <nav
      className="sidebar"
      aria-label="Places"
      data-region="sidebar"
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>(".sidebar-item")];
        const at = items.indexOf(document.activeElement as HTMLElement);
        if (at < 0) return;
        event.preventDefault();
        items[Math.min(Math.max(at + (event.key === "ArrowDown" ? 1 : -1), 0), items.length - 1)]?.focus();
      }}
    >
      <div className="sidebar-app">
        <Mark />
      </div>
      {PLACES.map(item)}
      <div className="sidebar-end">{item("settings")}</div>
    </nav>
  );
}
