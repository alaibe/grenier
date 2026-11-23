import { type ComponentType, useEffect, useState } from "react";
import { api, type Overview, sendPageView } from "./api.ts";
import { useLoad } from "./ui.tsx";
import { SCREENS, type ViewName } from "./usage/screens.ts";
import { useUsage } from "./usage/use-usage.ts";
import { Cost } from "./views/Cost.tsx";
import { Knowledge } from "./views/Knowledge.tsx";
import { Routines } from "./views/Routines.tsx";
import { Settings } from "./views/Settings.tsx";
import { Skills } from "./views/Skills.tsx";

export interface ViewProps {
  /** Shows another view; `focus` names what to show first in it: a record in Knowledge. */
  go: (view: ViewName, focus?: string) => void;
  focus?: string;
  /** Tells the shell that something it shows (the changes waiting to sync) may have changed. */
  changed: () => void;
}

export type { ViewName };

const VIEWS: Record<ViewName, ComponentType<ViewProps>> = {
  cost: Cost,
  knowledge: Knowledge,
  routines: Routines,
  skills: Skills,
  settings: Settings,
};

const loadOverview = () => api<Overview>("/overview");

/** The screen a link names, as #knowledge or #knowledge/<record>, for the app opened in a browser. */
function linked(): { view: ViewName; focus?: string } {
  const [view = "", focus] = window.location.hash.slice(1).split("/");
  if (!(view in SCREENS)) return { view: "cost" };
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
    <div className="grid min-h-screen grid-cols-[176px_minmax(0,1fr)]">
      <nav
        className="sticky top-0 flex h-screen flex-col gap-0.5 border-r border-line bg-side px-2.5 py-4.5"
        aria-label="Sections"
      >
        <p className="mx-2.5 mb-4.5 font-serif text-2xl font-semibold">Grenier</p>
        {(Object.keys(SCREENS) as ViewName[]).map((name) => (
          <button
            type="button"
            key={name}
            className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.75 text-left whitespace-nowrap ${current === name ? "bg-panel font-semibold inset-ring inset-ring-line" : "hover:bg-hover"}`}
            aria-current={current === name ? "page" : undefined}
            onClick={() => go(name)}
          >
            {SCREENS[name].title}
            {name === "knowledge" && waiting > 0 && (
              <span
                className="min-w-5 rounded-xl bg-accent px-1.5 text-center text-2xs leading-5 font-semibold text-accent-fg"
                title={`${waiting === 1 ? "1 record" : `${waiting} records`} not sent to the team yet`}
              >
                {waiting}
              </span>
            )}
          </button>
        ))}
        {overview.data && <p className="mx-2.5 mt-auto text-xs text-muted">Version {overview.data.version}</p>}
      </nav>
      <main className="px-8 pt-7 pb-12 max-md:px-5 max-md:pt-5.5 max-md:pb-10">
        <div className={current === "knowledge" ? "max-w-320" : "max-w-220"}>
          <View key={`${current}:${focus ?? ""}`} go={go} changed={overview.reload} {...(focus ? { focus } : {})} />
        </div>
      </main>
    </div>
  );
}
