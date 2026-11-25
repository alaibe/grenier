import type { Overview } from "@grenier/core/api";
import { ArrowLeft, ArrowRight, PanelLeft, RefreshCw } from "lucide-react";
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, sendPageView } from "./api.ts";
import { type Command, Palette } from "./palette.tsx";
import { Banner } from "./shell/banner.tsx";
import { linked, useHistory } from "./shell/history.ts";
import { PLACES } from "./shell/places.ts";
import { Sidebar, useSidebar } from "./shell/sidebar.tsx";
import { StatusBar } from "./shell/status-bar.tsx";
import { mac, TitleBar } from "./shell/title-bar.tsx";
import { LitPoint, ToastProvider, TooltipLayer, useLoad } from "./ui.tsx";
import { SCREENS, type ViewName } from "./usage/screens.ts";
import { useUsage } from "./usage/use-usage.ts";
import { Cost } from "./views/Cost.tsx";
import { Knowledge } from "./views/Knowledge.tsx";
import { Mcp } from "./views/Mcp.tsx";
import { Routines } from "./views/Routines.tsx";
import { Settings } from "./views/Settings.tsx";
import { Skills } from "./views/Skills.tsx";
import { Team } from "./views/Team.tsx";

export interface ViewProps {
  /** Shows another view; `focus` names what to show first in it: a record in Knowledge. */
  go: (view: ViewName, focus?: string) => void;
  focus?: string;
  /** Tells the shell that something it shows (the changes waiting to sync) may have changed. */
  changed: () => void;
  /** A member, not an admin: they read the team's pages, write in Me, and run what an admin shares. */
  member: boolean;
}

export type { ViewName };

const VIEWS: Record<ViewName, ComponentType<ViewProps>> = {
  knowledge: Knowledge,
  cost: Cost,
  routines: Routines,
  skills: Skills,
  mcp: Mcp,
  team: Team,
  settings: Settings,
};

const loadOverview = () => api<Overview>("/overview");

export function App() {
  return (
    <ToastProvider>
      <Shell />
      <TooltipLayer />
    </ToastProvider>
  );
}

/** The laibe design system's app shell (patterns/app-shell.md): title bar, banner, sidebar, content, status bar. */
function Shell() {
  const history = useHistory(linked());
  const { view: current, focus } = history.place;
  const overview = useLoad(loadOverview);
  const sidebar = useSidebar();
  const [palette, setPalette] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  const { push, move } = history;
  const reloadOverview = overview.reload;

  const go = useCallback(
    (name: ViewName, next?: string) => {
      push({ view: name, ...(next ? { focus: next } : {}) });
      reloadOverview();
    },
    [push, reloadOverview],
  );

  useEffect(() => {
    const follow = () => push(linked());
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [push]);

  useEffect(() => {
    document.title = `${SCREENS[current].title} — Grenier`;
    main.current?.scrollTo({ top: 0 });
  }, [current]);

  // The keys every app on the laibe design system shares (patterns/keyboard.md).
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const place = /^[1-9]$/.test(event.key) ? PLACES[Number(event.key) - 1] : undefined;
      if (mod && event.key.toLowerCase() === "k") setPalette((open) => !open);
      else if (palette) return;
      else if (mod && event.key === ",") go("settings");
      else if (mod && event.key === "\\") sidebar.toggle();
      else if (mod && event.key === "[") move(-1);
      else if (mod && event.key === "]") move(1);
      else if (mod && place) go(place);
      else if (event.key === "F6") {
        const regions = [nav.current, main.current].filter((region): region is HTMLElement => region !== null);
        const at = regions.findIndex((region) => region.contains(document.activeElement));
        const next = regions[(at + (event.shiftKey ? -1 : 1) + regions.length) % regions.length];
        (next?.querySelector<HTMLElement>('[aria-current="page"], button, a, input') ?? next)?.focus();
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [palette, go, sidebar.toggle, move]);

  useUsage(SCREENS[current].url, sendPageView);

  const commands: Command[] = useMemo(
    () => [
      { label: "Back", icon: ArrowLeft, keys: ["⌘", "["], run: () => move(-1) },
      { label: "Forward", icon: ArrowRight, keys: ["⌘", "]"], run: () => move(1) },
      { label: "Show or hide the sidebar", icon: PanelLeft, keys: ["⌘", "\\"], run: sidebar.toggle },
      { label: "Reload this view", icon: RefreshCw, run: () => window.location.reload() },
    ],
    [move, sidebar.toggle],
  );

  // The splash: the attic window on the dark, until the daemon first answers.
  if (!overview.data && !overview.error) {
    return (
      <div className="grid h-dvh place-items-center bg-void">
        <div className="grid animate-appear justify-items-center gap-4">
          <span className="motion-safe:animate-pulse">
            <LitPoint size={64} />
          </span>
          <p className="font-mono text-xs text-muted">&gt; opening the store…</p>
        </div>
      </div>
    );
  }

  const View = VIEWS[current];
  const waiting = overview.error ? 0 : (overview.data?.waiting ?? 0);
  const titleHeight = mac ? "var(--layout-titlebar-mac)" : "var(--layout-titlebar)";

  return (
    <div
      className="grid h-dvh overflow-hidden"
      style={{ gridTemplateRows: `${titleHeight} auto minmax(0, 1fr) var(--layout-statusbar)` }}
    >
      <TitleBar
        place={SCREENS[current].title}
        collapsed={sidebar.collapsed}
        canBack={history.canBack}
        canForward={history.canForward}
        onToggleSidebar={sidebar.toggle}
        onMove={move}
        onCommands={() => setPalette(true)}
      />
      <div>
        <Banner overview={overview.data} error={overview.error} retry={overview.reload} />
      </div>
      <div className="grid min-h-0" style={{ gridTemplateColumns: `${sidebar.width}px minmax(0, 1fr)` }}>
        <Sidebar
          ref={nav}
          current={current}
          go={go}
          collapsed={sidebar.collapsed}
          counts={{
            knowledge: {
              value: waiting,
              title: `${waiting === 1 ? "1 record" : `${waiting} records`} not sent to the team yet`,
            },
          }}
          onResize={sidebar.resize}
          onReset={sidebar.reset}
        />
        <main ref={main} tabIndex={-1} className="min-h-0 overflow-y-auto outline-none">
          <div className="px-8 pt-7 pb-12 max-md:px-5 max-md:pt-5.5 max-md:pb-10">
            <div className={current === "knowledge" ? "max-w-320" : "max-w-220"}>
              <View
                key={`${current}:${focus ?? ""}`}
                go={go}
                changed={overview.reload}
                member={overview.data?.role === "member"}
                {...(focus ? { focus } : {})}
              />
            </div>
          </div>
        </main>
      </div>
      <StatusBar overview={overview.data} error={overview.error} />
      {palette && <Palette go={go} commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}
