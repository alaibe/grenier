/**
 * The app's screens, by the name its views go by: the url usage statistics send for it, and the title the sidebar
 * shows. The shell keeps the same list (src-tauri/src/usage.rs) and refuses any other url.
 */
export const SCREENS = {
  dashboard: { url: "/dashboard", title: "Dashboard" },
  traces: { url: "/traces", title: "Traces" },
  cache: { url: "/cache", title: "Exploration cache" },
  budgets: { url: "/budgets", title: "Budgets" },
  sources: { url: "/sources", title: "Sources" },
  clients: { url: "/clients", title: "Clients and scopes" },
  audit: { url: "/audit", title: "Audit log" },
  review: { url: "/review", title: "Review queue" },
  settings: { url: "/settings", title: "Settings" },
} as const satisfies Record<string, { url: string; title: string }>;

export type ViewName = keyof typeof SCREENS;

export type ScreenUrl = (typeof SCREENS)[ViewName]["url"];
