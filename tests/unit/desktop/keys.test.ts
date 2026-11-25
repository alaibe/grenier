import { describe, expect, it } from "vitest";
import { ago, since } from "../../../apps/desktop/src/format.ts";
import { goLetters, PLACES, placeKeys } from "../../../apps/desktop/src/shell/places.ts";
import { type Command, hintsFor, Registry } from "../../../apps/desktop/src/shell/registry.ts";
import { caps, chordOf, spoken } from "../../../apps/desktop/src/ui/keys.ts";

const press = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const command = (id: string, keys: string, extra: Partial<Command> = {}): Command => ({
  id,
  label: id,
  keys,
  run: () => {},
  ...extra,
});

describe("the shared keys", () => {
  it("draws ⌘ on macOS and Ctrl elsewhere, one cap per key, a sequence joined by then", () => {
    expect(caps("mod+k", true)).toEqual([["⌘", "K"]]);
    expect(caps("mod+k", false)).toEqual([["Ctrl", "K"]]);
    expect(caps("g k", true)).toEqual([["G"], ["K"]]);
    expect(spoken("mod+enter", false)).toBe("Ctrl+Enter");
    expect(spoken("g k", true)).toBe("G then K");
  });

  it("reads ⌘ as Cmd on macOS and as Ctrl elsewhere, and ? as its own key", () => {
    expect(chordOf(press("k", { metaKey: true }), true)).toBe("mod+k");
    expect(chordOf(press("k", { ctrlKey: true }), true)).toBe("k");
    expect(chordOf(press("k", { ctrlKey: true }), false)).toBe("mod+k");
    expect(chordOf(press("?", { shiftKey: true }), false)).toBe("?");
    expect(chordOf(press("F6", { shiftKey: true }), false)).toBe("shift+f6");
    expect(chordOf(press("Shift", { shiftKey: true }), false)).toBeNull();
  });

  it("gives every place ⌘ and its number, Settings ⌘, and a G letter of its own", () => {
    expect(PLACES.map(placeKeys)).toEqual(PLACES.map((_, index) => `mod+${index + 1}`));
    expect(placeKeys("settings")).toBe("mod+,");
    const letters = Object.values(goLetters([...PLACES, "settings"]));
    expect(letters).toHaveLength(PLACES.length + 1);
    expect(new Set(letters).size).toBe(letters.length);
  });
});

describe("the command registry", () => {
  it("runs the newest command on a key, and a higher priority first", () => {
    const registry = new Registry();
    registry.set(Symbol(), [command("shell.close", "escape")]);
    registry.set(Symbol(), [command("view.close", "escape")]);
    expect(registry.find("escape")?.id).toBe("view.close");
    const toast = Symbol();
    registry.set(toast, [command("toast.dismiss", "escape", { priority: 1 })]);
    registry.set(Symbol(), [command("later.close", "escape")]);
    expect(registry.find("escape")?.id).toBe("toast.dismiss");
    registry.delete(toast);
    expect(registry.find("escape")?.id).toBe("later.close");
  });

  it("hints what has attention: the list's keys, an open item's, a dialog's, a pending chord's places", () => {
    const registry = new Registry();
    registry.set(Symbol(), [
      command("next", "j", { hint: { in: "list", says: "move", keys: "j+k", order: 10 } }),
      command("go:knowledge", "g k", { label: "Knowledge" }),
    ]);
    expect(hintsFor(registry).hints).toEqual([
      { keys: "j+k", says: "move" },
      { keys: "mod+k", says: "commands" },
    ]);
    const item = Symbol();
    registry.set(item, [command("save", "mod+enter", { hint: { in: "item", says: "save" } })]);
    expect(hintsFor(registry).attention.kind).toBe("item");
    registry.setChord("g");
    expect(hintsFor(registry).hints).toEqual([{ keys: "k", says: "knowledge" }]);
    registry.setChord(null);
    const close = registry.pushLayer({ kind: "dialog", hints: [{ keys: "escape", says: "cancel" }] });
    expect(hintsFor(registry).hints).toEqual([{ keys: "escape", says: "cancel" }]);
    close();
    registry.pushLayer({ kind: "palette", hints: [] });
    expect(hintsFor(registry).tries.length).toBeGreaterThan(0);
  });
});

describe("times in lists", () => {
  const now = new Date(2026, 10, 25, 12, 0).getTime();
  it("are short and relative, then a day, then a date", () => {
    expect(ago(now - 12_000, now)).toBe("12s");
    expect(ago(now - 4 * 60_000, now)).toBe("4m");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3h");
    expect(ago(now - 2 * 86_400_000, now)).toBe("Mon");
    expect(ago(new Date(2026, 10, 2).getTime(), now)).toBe("2 Nov");
    expect(since(now - 4 * 60_000, now)).toBe("4m ago");
    expect(since(now - 2 * 86_400_000, now)).toBe("Mon");
  });
});
