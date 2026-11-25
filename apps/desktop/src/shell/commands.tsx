import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { anywhere, chordOf } from "../ui/keys.ts";
import { type Attention, type Command, type Hint, type Layer, Registry, type Scope } from "./registry.ts";

export { type Command, type Hint, hintsFor, Registry } from "./registry.ts";

const RegistryContext = createContext<Registry | null>(null);

function useRegistry(): Registry {
  const registry = useContext(RegistryContext);
  if (!registry) throw new Error("useRegistry needs a CommandProvider");
  return registry;
}

/** The registry's current commands and state, re-read whenever they change. */
export function useRegistryState() {
  const registry = useRegistry();
  const state = useSyncExternalStore(registry.subscribe, () => registry.state);
  return { registry, state };
}

/** Registers a view's commands while it is mounted; pass them memoized. */
export function useCommands(commands: Command[], scope: Scope = "screen") {
  const registry = useRegistry();
  const [owner] = useState(() => Symbol("commands"));
  useEffect(() => {
    registry.set(owner, commands, scope);
  }, [registry, owner, commands, scope]);
  useEffect(() => () => registry.delete(owner), [registry, owner]);
}

/** A dialog or the palette, while it is open: global keys wait, and the status bar shows its hints. */
export function useLayer(kind: Layer["kind"], hints: Hint[] = []) {
  const registry = useRegistry();
  const said = JSON.stringify(hints);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the hints are compared by what they say
  useEffect(() => registry.pushLayer({ kind, hints }), [registry, kind, said]);
}

const CHORD_MS = 1500;

const textField = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLElement &&
  (element.isContentEditable ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLInputElement &&
      !["checkbox", "radio", "button", "submit", "range", "color"].includes(element.type)));

function fieldOf(element: Element | null): Attention | null {
  if (!textField(element)) return null;
  if (element instanceof HTMLInputElement && element.type === "search") {
    return { kind: "search", live: element.dataset.search === "live" };
  }
  return { kind: "writing", verb: element.closest<HTMLElement>("[data-verb]")?.dataset.verb ?? null };
}

/** Holds the registry and runs the one key listener of the app. */
export function CommandProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new Registry());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const endChord = () => {
      clearTimeout(timer);
      registry.setChord(null);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const chord = chordOf(event);
      if (!chord) return;
      // A dialog and the palette take their own keys; only the palette's ⌘K reaches past them.
      if (registry.layer && chord !== "mod+k") return;
      const pending = registry.state.chord;
      if (pending) {
        endChord();
        const command = registry.find(`${pending} ${chord}`);
        if (command) {
          event.preventDefault();
          command.run();
        }
        return;
      }
      const typing = textField(document.activeElement);
      if (typing && !anywhere(chord)) {
        if (chord === "escape") {
          event.preventDefault();
          (document.activeElement as HTMLElement).blur();
        }
        return;
      }
      if (chord === "g" && registry.commands.some((command) => command.keys?.startsWith("g "))) {
        event.preventDefault();
        registry.setChord("g");
        timer = setTimeout(endChord, CHORD_MS);
        return;
      }
      const command = registry.find(chord);
      if (!command) return;
      event.preventDefault();
      command.run();
    };
    const focus = () => registry.setField(fieldOf(document.activeElement));
    const blurred = () => setTimeout(focus);
    window.addEventListener("keydown", keydown);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blurred);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blurred);
    };
  }, [registry]);

  return <RegistryContext value={registry}>{children}</RegistryContext>;
}
