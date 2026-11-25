import type { Overview } from "@grenier/core/api";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { Notice } from "../ui/notice.tsx";

/** App-wide trouble only, under the title bar: the daemon not answering, or a team store older than this Grenier. */
export function Banner({
  overview,
  error,
  retry,
  toTeam,
}: {
  overview: Overview | null;
  error: string | null;
  retry: () => void;
  toTeam: () => void;
}) {
  if (!error && !overview?.outdated) return null;
  return (
    <div className="banner-region">
      {error ? (
        <Notice
          kind="err"
          banner
          action={
            <Button size="sm" icon={RefreshCw} onClick={retry}>
              Retry
            </Button>
          }
        >
          Grenier's daemon isn't answering, so nothing here is up to date.
        </Notice>
      ) : (
        <Notice
          kind="warn"
          banner
          action={
            <Button size="sm" trailing={ArrowRight} onClick={toTeam}>
              Update it
            </Button>
          }
        >
          The team store is older than this Grenier: sync waits until it is deployed again.
        </Notice>
      )}
    </div>
  );
}
