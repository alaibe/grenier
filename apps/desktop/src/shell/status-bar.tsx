import type { Overview } from "@grenier/core/api";
import type { ReactNode } from "react";
import { ago, Kbd, Status, times } from "../ui.tsx";

/** The bar along the bottom of every laibe app: is it working, what is waiting, what can I press. */
export function StatusBar({ overview, error }: { overview: Overview | null; error: string | null }) {
  const parts: ReactNode[] = [];
  if (error) parts.push(<Status key="error" kind="err" />, "Daemon unreachable");
  else if (overview) {
    if (overview.team) {
      parts.push(overview.team.lastSync ? `Synced ${ago(overview.team.lastSync)}` : "Not synced yet");
      if (overview.outdated) parts.push(<Status key="outdated" kind="warn" />, "Team store outdated");
      if (overview.waiting > 0) parts.push(`${overview.waiting} to sync`);
      if (overview.role) parts.push(overview.role);
    } else parts.push("This machine only");
    if (overview.paused > 0) parts.push(`${times(overview.paused, "session")} paused`);
  }
  const busy = !error && (overview?.waiting ?? 0) > 0;
  return (
    <footer className="z-(--layer-bars) flex items-center gap-2.5 overflow-hidden border-t border-line bg-void px-3 font-mono text-2xs font-medium tracking-label whitespace-nowrap text-muted uppercase">
      <span
        className={`size-1.5 shrink-0 rounded-full ${error ? "bg-danger" : "bg-accent shadow-[0_0_8px_var(--accent)]"} ${busy ? "motion-safe:animate-pulse" : ""}`}
      />
      <span className="text-fg">Grenier</span>
      <span aria-live="polite" className="flex items-center gap-2.5">
        {parts.map((part, index) =>
          typeof part === "string" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts are rebuilt on every render, in a fixed order
            <span key={index} className="flex items-center gap-2.5">
              <span className="text-subtle">·</span>
              {part}
            </span>
          ) : (
            part
          ),
        )}
      </span>
      <span className="ml-auto flex items-center gap-3 tracking-normal normal-case">
        <span className="flex items-center gap-1">
          <Kbd>⌘K</Kbd> commands
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⌘,</Kbd> settings
        </span>
        {overview && <span>v{overview.version}</span>}
      </span>
    </footer>
  );
}
