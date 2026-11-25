import { useCallback, useState } from "react";
import { SCREENS, type ViewName } from "../usage/screens.ts";

/** Where the app is: a view, and what it shows first (a record in Knowledge). */
export interface Place {
  view: ViewName;
  focus?: string;
}

/** The place a link names, as #knowledge or #knowledge/<record>, for the app opened in a browser. */
export function linked(): Place {
  const [view = "", focus] = window.location.hash.slice(1).split("/");
  if (!(view in SCREENS)) return { view: "knowledge" };
  return { view: view as ViewName, ...(focus ? { focus: decodeURIComponent(focus) } : {}) };
}

const KEPT = 50;

/** The places visited, to go back (⌘[) and forward (⌘]) through them. */
export function useHistory(start: Place) {
  const [state, setState] = useState({ stack: [start], index: 0 });
  const place = state.stack[state.index] ?? start;
  const push = useCallback((next: Place) => {
    setState(({ stack, index }) => ({
      stack: [...stack.slice(0, index + 1), next].slice(-KEPT),
      index: Math.min(index + 1, KEPT - 1),
    }));
  }, []);
  const move = useCallback((by: number) => {
    setState(({ stack, index }) => ({ stack, index: Math.max(0, Math.min(stack.length - 1, index + by)) }));
  }, []);
  return { place, push, move, canBack: state.index > 0, canForward: state.index < state.stack.length - 1 };
}
