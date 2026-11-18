import { useState } from "react";
import { api, type Overview } from "./api.ts";
import { useLoad } from "./ui.tsx";
import { Audit } from "./views/Audit.tsx";
import { Clients } from "./views/Clients.tsx";
import { Dashboard } from "./views/Dashboard.tsx";
import { Review } from "./views/Review.tsx";
import { Sources } from "./views/Sources.tsx";
import { Traces } from "./views/Traces.tsx";

export interface ViewProps {
  go: (view: ViewName) => void;
  /** Tells the shell that something it shows (the review count) may have changed. */
  changed: () => void;
}

const VIEWS = {
  dashboard: { label: "Dashboard", view: Dashboard },
  traces: { label: "Traces", view: Traces },
  sources: { label: "Sources", view: Sources },
  clients: { label: "Clients and scopes", view: Clients },
  audit: { label: "Audit log", view: Audit },
  review: { label: "Review queue", view: Review },
} as const;

export type ViewName = keyof typeof VIEWS;

const loadOverview = () => api<Overview>("/overview");

export function App() {
  const [current, setCurrent] = useState<ViewName>("dashboard");
  const overview = useLoad(loadOverview);
  const go = (name: ViewName) => {
    setCurrent(name);
    overview.reload();
  };
  const View = VIEWS[current].view;
  const pending = overview.error ? 0 : (overview.data?.pendingReview ?? 0);

  return (
    <div className="app">
      <nav className="nav" aria-label="Sections">
        <p className="brand">Grenier</p>
        {(Object.keys(VIEWS) as ViewName[]).map((name) => (
          <button
            type="button"
            key={name}
            className="nav-item"
            aria-current={current === name ? "page" : undefined}
            onClick={() => go(name)}
          >
            {VIEWS[name].label}
            {name === "review" && pending > 0 && (
              <span className="count" title={`${pending} to review`}>
                {pending}
              </span>
            )}
          </button>
        ))}
        {overview.data && <p className="version">Version {overview.data.version}</p>}
      </nav>
      <main className="main">
        <div className={current === "traces" ? "page wide" : "page"}>
          <View key={current} go={go} changed={overview.reload} />
        </div>
      </main>
    </div>
  );
}
