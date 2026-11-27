import { Flag, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { openFeedback } from "../api.ts";
import { Button } from "../ui/button.tsx";
import { Notice } from "../ui/notice.tsx";

/** Catches a render error below it, so one broken screen never blanks the window. */
export class CrashBoundary extends Component<
  { children: ReactNode; fallback: (error: Error, retry: () => void) => ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("grenier: a screen crashed", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    return error ? this.props.fallback(error, () => this.setState({ error: null })) : this.props.children;
  }
}

/** What a crash says: what happened, the way out, and where to report it; the error stays here, never in the report. */
export function Crashed({ error, retry, what }: { error: Error; retry: () => void; what: string }) {
  return (
    <div className="grid max-w-(--layout-reading) gap-3">
      <Notice
        kind="err"
        more={`${what} Try again, or report the problem: the form is public, so copy only what you would post openly.`}
        action={
          <Button size="sm" icon={RefreshCw} onClick={retry}>
            Try again
          </Button>
        }
      >
        {error.message || "Grenier hit an error it couldn't recover from."}
      </Notice>
      <div>
        <Button size="sm" icon={Flag} onClick={() => void openFeedback("problem").catch(() => {})}>
          Report a problem
        </Button>
      </div>
    </div>
  );
}
