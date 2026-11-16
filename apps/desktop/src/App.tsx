import { useState } from "react";
import { Audit } from "./views/Audit.tsx";
import { Clients } from "./views/Clients.tsx";
import { Dashboard } from "./views/Dashboard.tsx";
import { Review } from "./views/Review.tsx";
import { Sources } from "./views/Sources.tsx";

const VIEWS = {
  dashboard: { label: "Dashboard", view: Dashboard },
  sources: { label: "Sources", view: Sources },
  clients: { label: "Clients and scopes", view: Clients },
  audit: { label: "Audit log", view: Audit },
  review: { label: "Review queue", view: Review },
} as const;

type ViewName = keyof typeof VIEWS;

export function App() {
  const [current, setCurrent] = useState<ViewName>("dashboard");
  const View = VIEWS[current].view;
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
            onClick={() => setCurrent(name)}
          >
            {VIEWS[name].label}
          </button>
        ))}
      </nav>
      <main className="main">
        <h1>{VIEWS[current].label}</h1>
        <View />
      </main>
    </div>
  );
}
