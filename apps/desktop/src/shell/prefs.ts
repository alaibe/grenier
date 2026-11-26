import { useCallback, useEffect, useSyncExternalStore } from "react";
import { store, stored } from "../storage.ts";

export type Theme = "dark" | "light" | "system";

/** This person's choices for the app's look on this computer, kept in its window's storage. */
interface Prefs {
  theme: Theme;
  /** The status bar's hints: Settings › General › Quick tips (components/status-bar.md#hints). */
  tips: boolean;
}

const KEY = "grenier.prefs";
const DEFAULTS: Prefs = { theme: "system", tips: true };
const listeners = new Set<() => void>();

let current: Prefs = { ...DEFAULTS, ...stored<Partial<Prefs>>(KEY, {}) };

/** Dark, Light, or the system's, on the root (patterns/app-shell.md#root-element). */
function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function usePrefs(): [Prefs, (change: Partial<Prefs>) => void] {
  const prefs = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  const set = useCallback((change: Partial<Prefs>) => {
    current = { ...current, ...change };
    store(KEY, current);
    for (const listener of listeners) listener();
  }, []);
  useEffect(() => applyTheme(prefs.theme), [prefs.theme]);
  return [prefs, set];
}
