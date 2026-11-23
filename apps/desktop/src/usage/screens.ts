/** src-tauri/src/usage.rs keeps the same urls and refuses any other. */
export const SCREENS = {
  cost: { url: "/cost", title: "Cost" },
  knowledge: { url: "/knowledge", title: "Knowledge" },
  routines: { url: "/routines", title: "Routines" },
  skills: { url: "/skills", title: "Skills" },
  settings: { url: "/settings", title: "Settings" },
} as const satisfies Record<string, { url: string; title: string }>;

export type ViewName = keyof typeof SCREENS;

export type ScreenUrl = (typeof SCREENS)[ViewName]["url"];
