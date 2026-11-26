import { Mark } from "../ui/brand.tsx";
import { spoken } from "../ui/keys.ts";
import { SCREENS, type ViewName } from "../usage/screens.ts";
import { PLACE_ICONS, PLACES, placeKeys } from "./places.ts";
import { href } from "./router.ts";

/** The app's places as a rail of icons (components/sidebar.md): names in tooltips, Settings at the bottom. */
export function Sidebar({ current, go }: { current: ViewName; go: (place: ViewName) => void }) {
  const item = (name: ViewName) => {
    const Icon = PLACE_ICONS[name];
    const title = SCREENS[name].title;
    return (
      <a
        key={name}
        href={href({ place: name })}
        className="sidebar-item badge-host"
        aria-current={current === name ? "page" : undefined}
        aria-label={title}
        aria-keyshortcuts={spoken(placeKeys(name))}
        title={title}
        data-tip-side="end"
        data-keys={placeKeys(name)}
        onClick={(event) => {
          event.preventDefault();
          go(name);
        }}
      >
        <Icon className="icon" aria-hidden="true" />
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
