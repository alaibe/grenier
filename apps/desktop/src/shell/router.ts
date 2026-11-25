import { useCallback, useEffect, useRef, useState } from "react";
import { SCREENS, type ViewName } from "../usage/screens.ts";

/** Where the app is: a place, and the item open in it (a record in Knowledge). */
export interface Route {
  place: ViewName;
  item?: string;
}

const FIRST: Route = { place: "knowledge" };

/** The route a hash names: #knowledge, or #knowledge/<record>. */
export function parse(hash: string): Route {
  const [place = "", item] = hash.replace(/^#/, "").split("/");
  if (!(place in SCREENS)) return FIRST;
  return { place: place as ViewName, ...(item ? { item: decodeURIComponent(item) } : {}) };
}

export function href(route: Route): string {
  return `#${route.place}${route.item ? `/${encodeURIComponent(route.item)}` : ""}`;
}

/** The entries of this window's history: each knows its index, so back and forward know when they can go. */
interface Entry {
  index: number;
}

const indexOf = (state: unknown) => (state as Entry | null)?.index;

/**
 * Places and items live in the URL's hash, in the window's own history: links open them, and back and forward
 * (⌘[ ⌘], the mouse's buttons) go through them.
 */
export function useRouter() {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  const [index, setIndex] = useState(() => indexOf(window.history.state) ?? 0);
  const [last, setLast] = useState(index);
  const current = useRef(index);
  current.current = index;

  useEffect(() => {
    if (indexOf(window.history.state) === undefined) window.history.replaceState({ index: 0 } satisfies Entry, "");
    const follow = () => {
      let at = indexOf(window.history.state);
      // A link followed by the browser itself: it becomes the newest entry.
      if (at === undefined) {
        at = current.current + 1;
        window.history.replaceState({ index: at } satisfies Entry, "");
        setLast(at);
      }
      setIndex(at);
      setRoute(parse(window.location.hash));
    };
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);

  const navigate = useCallback(
    (next: Route, { replace = false }: { replace?: boolean } = {}) => {
      if (href(next) === window.location.hash) return;
      const at = replace ? index : index + 1;
      if (replace) window.history.replaceState({ index: at } satisfies Entry, "", href(next));
      else window.history.pushState({ index: at } satisfies Entry, "", href(next));
      setIndex(at);
      if (!replace) setLast(at);
      setRoute(next);
    },
    [index],
  );

  return {
    route,
    navigate,
    back: useCallback(() => window.history.back(), []),
    forward: useCallback(() => window.history.forward(), []),
    canBack: index > 0,
    canForward: index < last,
  };
}
