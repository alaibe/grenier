import { BookOpen, Coins, type LucideIcon, Plug, Repeat, ScrollText, Settings, Sparkles, Users } from "lucide-react";
import type { Shortcut } from "../ui/keys.ts";
import { SCREENS, type ViewName } from "../usage/screens.ts";

/** The app's places, in the sidebar's order: ⌘1 is the first. Settings sits apart, at the bottom, on ⌘,. */
export const PLACES = (Object.keys(SCREENS) as ViewName[]).filter((name) => name !== "settings");

/** Each place's icon, in the sidebar, its tooltip and the palette. */
export const PLACE_ICONS: Record<ViewName, LucideIcon> = {
  knowledge: BookOpen,
  cost: Coins,
  routines: Repeat,
  skills: Sparkles,
  mcp: Plug,
  instructions: ScrollText,
  team: Users,
  settings: Settings,
};

const CONSONANTS = /[bcdfghjklmnpqrstvwxz]/;

/**
 * G then a letter goes to a place: its first letter, or for a second place with the same first letter its next
 * consonant (patterns/keyboard.md).
 */
export function goLetters(names: readonly ViewName[]): Partial<Record<ViewName, string>> {
  const taken = new Set<string>();
  const letters: Partial<Record<ViewName, string>> = {};
  for (const name of names) {
    const title = SCREENS[name].title.toLowerCase();
    const letter = [title[0], ...[...title.slice(1)].filter((char) => CONSONANTS.test(char))].find(
      (char): char is string => char !== undefined && !taken.has(char),
    );
    if (!letter) continue;
    taken.add(letter);
    letters[name] = letter;
  }
  return letters;
}

/** The keys that go to each place: ⌘ and its number, ⌘, for Settings. */
export function placeKeys(name: ViewName): Shortcut {
  return name === "settings" ? "mod+," : `mod+${PLACES.indexOf(name) + 1}`;
}
