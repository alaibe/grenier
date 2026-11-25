import { useCallback, useEffect, useSyncExternalStore } from "react";

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

function read(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

let current = read();

/** Dark, Light, or the system's, on the root (patterns/app-shell.md#root-element). */
export function applyTheme(theme: Theme) {
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
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {}
    for (const listener of listeners) listener();
  }, []);
  useEffect(() => applyTheme(prefs.theme), [prefs.theme]);
  return [prefs, set];
}
