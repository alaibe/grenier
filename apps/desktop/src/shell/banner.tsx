import type { Overview } from "@grenier/core/api";
import { RefreshCw } from "lucide-react";
import { Button, Status } from "../ui.tsx";

/** App-wide trouble only, under the title bar: the daemon not answering, or a team store older than this Grenier. */
export function Banner({
  overview,
  error,
  retry,
}: {
  overview: Overview | null;
  error: string | null;
  retry: () => void;
}) {
  if (!error && !overview?.outdated) return null;
  return (
    <div
      role={error ? "alert" : "status"}
      className="z-(--layer-bars) flex min-h-9 items-center gap-2.5 border-b border-line bg-void px-3 py-1.5 text-sm"
    >
      <Status kind={error ? "err" : "warn"} />
      <span className="flex-1">
        {error
          ? "Grenier's daemon isn't answering, so nothing here is up to date."
          : "The team store is older than this Grenier: sync waits until it is deployed again."}
      </span>
      {error && (
        <Button quiet icon={RefreshCw} className="h-7" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
