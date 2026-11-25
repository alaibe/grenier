/** True on macOS: ⌘ and the key symbols there, Ctrl and the key names elsewhere (patterns/keyboard.md). */
export const mac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/**
 * A shortcut, written once for every platform: keys of one chord joined by "+", the steps of a sequence by a space.
 * "mod+k" is ⌘K on macOS and Ctrl+K elsewhere; "g k" is G then K.
 */
export type Shortcut = string;

const NAMES: Record<string, [string, string]> = {
  mod: ["⌘", "Ctrl"],
  shift: ["⇧", "Shift"],
  alt: ["⌥", "Alt"],
  enter: ["↵", "Enter"],
  escape: ["Esc", "Esc"],
  backspace: ["⌫", "Backspace"],
  arrowup: ["↑", "↑"],
  arrowdown: ["↓", "↓"],
  arrowleft: ["←", "←"],
  arrowright: ["→", "→"],
  space: ["Space", "Space"],
};

/** The caps of each step of a shortcut, as they are drawn: [["⌘", "K"]], or [["G"], ["K"]] for a sequence. */
export function caps(shortcut: Shortcut, onMac = mac): string[][] {
  return shortcut.split(" ").map((step) =>
    step.split("+").map((key) => {
      const named = NAMES[key];
      if (named) return onMac ? named[0] : named[1];
      return key.length === 1 ? key.toUpperCase() : key.toUpperCase();
    }),
  );
}

/** A shortcut as one line of text, for a tooltip or a title: "⌘K", "Ctrl+K", "G then K". */
export function spoken(shortcut: Shortcut, onMac = mac): string {
  return caps(shortcut, onMac)
    .map((step) => step.join(onMac ? "" : "+"))
    .join(" then ");
}

/** The chord a key press makes, written as a Shortcut's step; null for a lone modifier. */
export function chordOf(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  onMac = mac,
): string | null {
  const key = event.key.toLowerCase();
  if (["meta", "control", "alt", "shift"].includes(key)) return null;
  const parts: string[] = [];
  if (onMac ? event.metaKey : event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  // A symbol shift makes (? on most layouts) is its own key.
  if (event.shiftKey && (key.length > 1 || /[a-z0-9]/.test(key))) parts.push("shift");
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

/** What a text field does itself with ⌘ (or Ctrl): undo and redo its typing. */
const FIELD_CHORDS = ["mod+z", "mod+shift+z", "mod+y"];

/** Whether a chord works while a text field has focus: one with ⌘ (or Ctrl) the field doesn't own, or a function key. */
export const anywhere = (chord: string) =>
  (chord.includes("mod+") && !FIELD_CHORDS.includes(chord)) || /^(shift\+)?f\d+$/.test(chord);
