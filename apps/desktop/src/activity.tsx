import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/** Below this, work shows nothing: the old content stays (patterns/empty-and-loading.md). */
const NOTICEABLE_MS = 300;
const SAVED_MS = 2500;

interface Activity {
  /** What runs now, after it has run long enough to notice; null for work without a name, such as a load. */
  working: (string | null)[];
  /** A setting that saved as you went, said for a moment. */
  saved: boolean;
}

const State = createContext<Activity>({ working: [], saved: false });
const Actions = createContext<{ begin: (what: string | null) => () => void; flashSaved: () => void }>({
  begin: () => () => {},
  flashSaved: () => {},
});

/** Collects the app's work in progress, for the status bar's pulsing dot and its busy segment. */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const [working, setWorking] = useState<{ id: number; what: string | null }[]>([]);
  const [saved, setSaved] = useState(false);
  const next = useRef(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const begin = useCallback((what: string | null) => {
    next.current += 1;
    const id = next.current;
    const timer = setTimeout(() => setWorking((all) => [...all, { id, what }]), NOTICEABLE_MS);
    return () => {
      clearTimeout(timer);
      setWorking((all) => all.filter((entry) => entry.id !== id));
    };
  }, []);
  const flashSaved = useCallback(() => {
    setSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), SAVED_MS);
  }, []);
  useEffect(() => () => clearTimeout(savedTimer.current), []);
  const actions = useMemo(() => ({ begin, flashSaved }), [begin, flashSaved]);
  const state = useMemo(() => ({ working: working.map((entry) => entry.what), saved }), [working, saved]);
  return (
    <Actions value={actions}>
      <State value={state}>{children}</State>
    </Actions>
  );
}

export const useActivity = () => useContext(State);

/** Marks work as running; the function it returns marks it done. */
export const useWork = () => useContext(Actions).begin;

/** Says SAVED in the status bar: a setting that saves as you go (patterns/forms.md). */
export const useSaved = () => useContext(Actions).flashSaved;
