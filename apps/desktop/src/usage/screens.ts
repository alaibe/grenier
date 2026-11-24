/** src-tauri/src/usage.rs keeps the same urls and refuses any other. */
export const SCREENS = {
  knowledge: { url: "/knowledge", title: "Knowledge" },
  cost: { url: "/cost", title: "Cost" },
  routines: { url: "/routines", title: "Routines" },
  skills: { url: "/skills", title: "Skills" },
  mcp: { url: "/mcp", title: "MCP" },
  team: { url: "/team", title: "Team" },
  settings: { url: "/settings", title: "Settings" },
} as const satisfies Record<string, { url: string; title: string }>;

export type ViewName = keyof typeof SCREENS;

export type ScreenUrl = (typeof SCREENS)[ViewName]["url"];
