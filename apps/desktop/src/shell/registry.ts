import type { LucideIcon } from "lucide-react";
import type { Shortcut } from "../ui/keys.ts";

/** Where a hint shows when no layer, chord or field has the person's attention (components/status-bar.md#hints). */
export type HintPlace = "list" | "item";

/** An action of the app: what the palette lists, a key runs, the status bar hints, `?` shows (patterns/keyboard.md). */
export interface Command {
  id: string;
  /** Sentence case, a verb first: "New page", "Sync now". */
  label: string;
  icon?: LucideIcon;
  keys?: Shortcut;
  /** More keys that do the same, not drawn: ↓ beside J. */
  also?: Shortcut[];
  group?: "Actions" | "Go to";
  /** Its hint in the status bar; `keys` draws something else than its own keys there (J K for move). */
  hint?: { in: HintPlace; says: string; keys?: Shortcut; order?: number };
  /** Kept out of the palette: moving through a list, closing what is open. */
  hidden?: boolean;
  /** Wins over the others on the same key: the newest toast's Esc and ⌘Z. */
  priority?: number;
  run: () => void;
}

export interface Hint {
  keys: Shortcut;
  says: string;
}

/** What has the person's attention, in the order the status bar asks (components/status-bar.md#hints). */
export type Attention =
  | { kind: "chord" }
  | { kind: "palette" }
  | { kind: "dialog"; hints: Hint[] }
  | { kind: "writing"; verb: string | null }
  | { kind: "search"; live: boolean }
  | { kind: "item" }
  | { kind: "list" };

/** Who registered a set: the shell, for every screen, or the current screen, whose commands win on the same id. */
export type Scope = "shell" | "screen";

const SCOPES: Scope[] = ["shell", "screen"];

export interface Layer {
  kind: "dialog" | "palette";
  hints: Hint[];
}

/** One store for every command, layer and pending chord; the shell, the palette, the bar and `?` read it. */
export class Registry {
  #sets = new Map<symbol, { scope: Scope; commands: Command[] }>();
  #layers: Layer[] = [];
  #listeners = new Set<() => void>();
  #commands: Command[] = [];
  #state = { chord: null as string | null, field: null as Attention | null, version: 0 };

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #emit() {
    const byId = new Map<string, Command>();
    for (const scope of SCOPES) {
      for (const set of this.#sets.values()) {
        if (set.scope === scope) for (const command of set.commands) byId.set(command.id, command);
      }
    }
    this.#commands = [...byId.values()];
    this.#state = { ...this.#state, version: this.#state.version + 1 };
    for (const listener of this.#listeners) listener();
  }

  /** Registers or replaces an owner's set, which keeps its place among the others. */
  set(owner: symbol, commands: Command[], scope: Scope = "screen") {
    this.#sets.set(owner, { scope, commands });
    this.#emit();
  }

  delete(owner: symbol) {
    if (this.#sets.delete(owner)) this.#emit();
  }

  pushLayer(layer: Layer) {
    this.#layers.push(layer);
    this.#emit();
    return () => {
      this.#layers = this.#layers.filter((entry) => entry !== layer);
      this.#emit();
    };
  }

  get commands(): Command[] {
    return this.#commands;
  }

  get layer(): Layer | undefined {
    return this.#layers.at(-1);
  }

  get state() {
    return this.#state;
  }

  setChord(chord: string | null) {
    this.#state = { ...this.#state, chord };
    this.#emit();
  }

  setField(field: Attention | null) {
    if (JSON.stringify(field) === JSON.stringify(this.#state.field)) return;
    this.#state = { ...this.#state, field };
    this.#emit();
  }

  /** The command a key press runs: the highest priority, then the screen's over the shell's, then the latest registered. */
  find(chord: string): Command | undefined {
    let found: Command | undefined;
    for (const command of this.#commands) {
      if (command.keys !== chord && !command.also?.includes(chord)) continue;
      if (!found || (command.priority ?? 0) >= (found.priority ?? 0)) found = command;
    }
    return found;
  }

  attention(): Attention {
    if (this.#state.chord) return { kind: "chord" };
    const layer = this.layer;
    if (layer?.kind === "palette") return { kind: "palette" };
    if (layer) return { kind: "dialog", hints: layer.hints };
    if (this.#state.field) return this.#state.field;
    return this.#commands.some((command) => command.hint?.in === "item") ? { kind: "item" } : { kind: "list" };
  }
}

/** What the palette suggests trying while it is open. */
export const PALETTE_TRIES = ["new page", "sync", "cost"];

/** The hints of what has the person's attention, at most five (components/status-bar.md#hints). */
export function hintsFor(registry: Registry): { attention: Attention; hints: Hint[]; tries: string[] } {
  const attention = registry.attention();
  const commands = registry.commands;
  const of = (place: "list" | "item") =>
    commands
      .filter((command) => command.hint?.in === place)
      .sort((a, b) => (a.hint?.order ?? 50) - (b.hint?.order ?? 50))
      .map((command) => ({ keys: command.hint?.keys ?? command.keys ?? "", says: command.hint?.says ?? "" }));
  const palette = { keys: "mod+k", says: "commands" };
  let hints: Hint[] = [];
  switch (attention.kind) {
    case "chord":
      hints = commands
        .filter((command) => command.keys?.startsWith(`${registry.state.chord} `))
        .map((command) => ({ keys: command.keys?.split(" ")[1] ?? "", says: command.label.toLowerCase() }));
      break;
    case "palette":
      return { attention, hints: [], tries: PALETTE_TRIES };
    case "dialog":
      hints = attention.hints;
      break;
    case "writing":
      hints = [
        ...(attention.verb ? [{ keys: "mod+enter", says: attention.verb }] : []),
        { keys: "escape", says: "leave" },
      ];
      break;
    case "search":
      hints = attention.live
        ? [
            { keys: "arrowdown", says: "move" },
            { keys: "escape", says: "clear" },
          ]
        : [
            { keys: "enter", says: "search" },
            { keys: "escape", says: "clear" },
          ];
      break;
    case "item":
      hints = [...of("item"), palette];
      break;
    case "list":
      hints = [...of("list"), palette];
      break;
  }
  return { attention, hints: hints.slice(0, attention.kind === "chord" ? 9 : 5), tries: [] };
}
