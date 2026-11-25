import { BookOpen, Coins, type LucideIcon, Plug, Repeat, Settings, Sparkles, Users } from "lucide-react";
import { SCREENS, type ViewName } from "../usage/screens.ts";

/** The app's places, in the sidebar's order: ⌘1 is the first. */
export const PLACES = Object.keys(SCREENS) as ViewName[];

/** Each place's icon, in the sidebar, its tooltip and the palette. */
export const PLACE_ICONS: Record<ViewName, LucideIcon> = {
  knowledge: BookOpen,
  cost: Coins,
  routines: Repeat,
  skills: Sparkles,
  mcp: Plug,
  team: Users,
  settings: Settings,
};
