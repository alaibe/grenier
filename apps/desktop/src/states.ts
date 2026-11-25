import type { StatusKind } from "./ui/tag.tsx";

/** Every state Grenier shows, as the tag it shows: the kind gives the colour, the word the meaning. */
const STATES: Record<string, [StatusKind, string]> = {
  running: ["live", "running"],
  doing: ["live", "doing"],
  done: ["ok", "done"],
  failed: ["err", "failed"],
  cut: ["warn", "cut"],
  "to-do": ["draft", "to do"],
  installed: ["ok", "installed"],
  update: ["warn", "update"],
  available: ["ok", "available"],
  busy: ["live", "busy"],
  away: ["draft", "away"],
};

/** The tag for a state's name; a name Grenier doesn't know shows as a neutral tag with its own word. */
export function stateTag(state: string): { kind: StatusKind; word: string } {
  const [kind, word] = STATES[state] ?? ["draft", state];
  return { kind, word };
}
