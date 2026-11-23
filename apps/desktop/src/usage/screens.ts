/**
 * The app's screens, by the name its views go by: the url usage statistics send for it, and the title the sidebar
 * shows. The shell keeps the same list (src-tauri/src/usage.rs) and refuses any other url.
 */
export const SCREENS = {
  dashboard: { url: "/dashboard", title: "Dashboard" },
  knowledge: { url: "/knowledge", title: "Knowledge" },
  requests: { url: "/requests", title: "Requests" },
  team: { url: "/team", title: "Team" },
  routines: { url: "/routines", title: "Routines" },
  skills: { url: "/skills", title: "Skills and servers" },
  machine: { url: "/machine", title: "This machine" },
  traces: { url: "/traces", title: "Traces" },
  clients: { url: "/clients", title: "Clients and spaces" },
  settings: { url: "/settings", title: "Settings" },
} as const satisfies Record<string, { url: string; title: string }>;

export type ViewName = keyof typeof SCREENS;

export type ScreenUrl = (typeof SCREENS)[ViewName]["url"];
