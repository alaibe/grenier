import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { anywhere, chordOf } from "../ui/keys.ts";
import { type Attention, type Command, type Hint, type Layer, Registry, type Scope } from "./registry.ts";

export { type Command, hintsFor } from "./registry.ts";

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

/**
 * Registers the actions an item's page shows as buttons, so the palette and `?` list them too: registered again only
 * when what they say changes, each run as it is when chosen. A component, so a page registers them where its data is.
 */
export function PageCommands({ commands }: { commands: Command[] }) {
  const latest = useRef(commands);
  latest.current = commands;
  const said = JSON.stringify(commands.map(({ run: _run, icon: _icon, ...shown }) => shown));
  // biome-ignore lint/correctness/useExhaustiveDependencies: the commands are compared by what they say
  const stable = useMemo<Command[]>(
    () =>
      latest.current.map((command) => ({
        ...command,
        run: () => latest.current.find((now) => now.id === command.id)?.run(),
      })),
    [said],
  );
  useCommands(stable);
  return null;
}

/** ⌘↵ and ⌘S save what the page edits, while it can be saved; the save runs as it is when the keys are pressed. */
export function useSaveCommand(id: string, label: string, enabled: boolean, save: () => void) {
  const latest = useRef(save);
  latest.current = save;
  const commands = useMemo<Command[]>(
    () =>
      enabled
        ? [
            {
              id,
              label,
              keys: "mod+enter",
              also: ["mod+s"],
              hint: { in: "item", says: "save", order: 10 },
              run: () => latest.current(),
            },
          ]
        : [],
    [id, label, enabled],
  );
  useCommands(commands);
}

/**
 * A dialog or the palette, while it is open: global keys wait, the status bar shows its hints, and `key` gets every
 * key press, wherever focus is, as it is when pressed.
 */
export function useLayer(kind: Layer["kind"], hints: Hint[] = [], key?: (chord: string) => boolean) {
  const registry = useRegistry();
  const latest = useRef(key);
  latest.current = key;
  const said = JSON.stringify(hints);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the hints are compared by what they say
  useEffect(
    () => registry.pushLayer({ kind, hints, key: (chord) => latest.current?.(chord) ?? false }),
    [registry, kind, said],
  );
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
      const layered = registry.layerKey(chord);
      if (layered !== null) {
        if (layered) event.preventDefault();
        return;
      }
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
