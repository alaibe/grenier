import { useEffect } from "react";

/** Calls `refresh` every `ms` while the window shows, or not at all while `ms` is null. */
export function usePolling(refresh: () => void, ms: number | null) {
  useEffect(() => {
    if (ms === null) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, ms);
    return () => window.clearInterval(timer);
  }, [refresh, ms]);
}
