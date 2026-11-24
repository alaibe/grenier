import type { Overview } from "@grenier/core/api";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { api, sendPageView } from "./api.ts";
import { ago, Mark, Status, times, useLoad } from "./ui.tsx";
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

/** The screen a link names, as #knowledge or #knowledge/<record>, for the app opened in a browser. */
function linked(): { view: ViewName; focus?: string } {
  const [view = "", focus] = window.location.hash.slice(1).split("/");
  if (!(view in SCREENS)) return { view: "knowledge" };
  return { view: view as ViewName, ...(focus ? { focus: decodeURIComponent(focus) } : {}) };
}

export function App() {
  const [current, setCurrent] = useState<ViewName>(() => linked().view);
  const [focus, setFocus] = useState<string | undefined>(() => linked().focus);
  const overview = useLoad(loadOverview);
  const go = (name: ViewName, next?: string) => {
    setCurrent(name);
    setFocus(next);
    overview.reload();
  };
  useEffect(() => {
    const follow = () => {
      const next = linked();
      setCurrent(next.view);
      setFocus(next.focus);
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  useUsage(SCREENS[current].url, sendPageView);
  const View = VIEWS[current];
  const waiting = overview.error ? 0 : (overview.data?.waiting ?? 0);

  return (
    <div className="grid min-h-screen grid-cols-[232px_minmax(0,1fr)] max-md:grid-cols-[176px_minmax(0,1fr)]">
      <nav
        className="sticky top-0 flex h-[calc(100vh-24px)] flex-col gap-0.5 border-r border-line bg-side px-2 py-3.5"
        aria-label="Sections"
      >
        <p className="mx-2 mb-4 flex items-center gap-2 font-mono text-sm font-semibold">
          <Mark />
          Grenier
        </p>
        {(Object.keys(SCREENS) as ViewName[]).map((name) => (
          <button
            type="button"
            key={name}
            className={`flex h-7 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 text-left font-mono text-sm font-medium whitespace-nowrap ${current === name ? "bg-accent-soft text-fg" : "text-fg hover:bg-hover"}`}
            aria-current={current === name ? "page" : undefined}
            onClick={() => go(name)}
          >
            {SCREENS[name].title}
            {name === "knowledge" && waiting > 0 && (
              <span
                className="font-mono text-xs text-accent tabular-nums"
                title={`${waiting === 1 ? "1 record" : `${waiting} records`} not sent to the team yet`}
              >
                {waiting}
              </span>
            )}
          </button>
        ))}
      </nav>
      <main className="px-8 pt-7 pb-16 max-md:px-5 max-md:pt-5.5 max-md:pb-14">
        <div className={current === "knowledge" ? "max-w-320" : "max-w-220"}>
          <View
            key={`${current}:${focus ?? ""}`}
            go={go}
            changed={overview.reload}
            member={overview.data?.role === "member"}
            {...(focus ? { focus } : {})}
          />
        </div>
      </main>
      <StatusBar overview={overview.data} error={overview.error} />
    </div>
  );
}

/** The bar along the bottom of every laibe app: is it working, and what is waiting. */
function StatusBar({ overview, error }: { overview: Overview | null; error: string | null }) {
  const parts: ReactNode[] = [];
  if (error) parts.push(<Status key="error" kind="err" />, "Daemon unreachable");
  else if (overview) {
    if (overview.team) {
      parts.push(overview.team.lastSync ? `Synced ${ago(overview.team.lastSync)}` : "Not synced yet");
      if (overview.outdated) parts.push(<Status key="outdated" kind="warn" />, "Team store outdated");
      if (overview.waiting > 0) parts.push(`${overview.waiting} to sync`);
      if (overview.role) parts.push(overview.role);
    } else parts.push("This machine only");
    if (overview.paused > 0) parts.push(`${times(overview.paused, "session")} paused`);
  }
  const busy = !error && (overview?.waiting ?? 0) > 0;
  return (
    <footer className="fixed inset-x-0 bottom-0 z-10 flex h-6 items-center gap-2.5 overflow-hidden border-t border-line bg-void px-3 font-mono text-2xs font-medium tracking-label whitespace-nowrap text-muted uppercase">
      <span
        className={`size-1.5 shrink-0 rounded-full ${error ? "bg-danger" : "bg-accent shadow-[0_0_8px_var(--accent)]"} ${busy ? "motion-safe:animate-pulse" : ""}`}
      />
      <span className="text-fg">Grenier</span>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are rebuilt on every render, in a fixed order
          <span key={index} className="flex items-center gap-2.5">
            <span className="text-subtle">·</span>
            {part}
          </span>
        ) : (
          part
        ),
      )}
      {overview && <span className="ml-auto normal-case">v{overview.version}</span>}
    </footer>
  );
}
