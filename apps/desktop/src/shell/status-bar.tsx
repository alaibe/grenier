import type { Overview } from "@grenier/core/api";
import { Fragment, type ReactNode } from "react";
import { useActivity } from "../activity.tsx";
import { since, times } from "../format.ts";
import { Keys } from "../ui/keycap.tsx";
import { Status } from "../ui/tag.tsx";
import type { ViewName } from "../usage/screens.ts";
import { hintsFor, useRegistryState } from "./commands.tsx";
import { usePrefs } from "./prefs.ts";

interface Segment {
  key: string;
  content: ReactNode;
  /** Where clicking it goes: the matching details or settings. */
  open?: () => void;
  title?: string;
}

/**
 * The bar along the bottom (components/status-bar.md): the lit point, the app, what is going on, each segment opening
 * its details; then the keys that matter for what has the person's attention, unless Quick tips are off.
 */
export function StatusBar({
  overview,
  error,
  go,
  retry,
}: {
  overview: Overview | null;
  error: string | null;
  go: (place: ViewName) => void;
  retry: () => void;
}) {
  const { working, saved } = useActivity();
  const [prefs] = usePrefs();
  const { registry } = useRegistryState();
  const { hints, tries } = hintsFor(registry);

  const segments: Segment[] = [];
  if (error) {
    segments.push({
      key: "daemon",
      content: [<Status key="tag" kind="err" />, "Daemon unreachable"],
      open: retry,
      title: "Try again",
    });
  } else if (overview) {
    if (overview.team) {
      segments.push({
        key: "sync",
        content: overview.team.lastSync ? `Synced ${since(overview.team.lastSync)}` : "Not synced yet",
        open: () => go("team"),
      });
      if (overview.outdated) {
        segments.push({
          key: "outdated",
          content: [<Status key="tag" kind="warn" />, "Team store outdated"],
          open: () => go("team"),
        });
      }
      if (overview.waiting > 0) {
        segments.push({
          key: "waiting",
          content: `${overview.waiting} to sync`,
          open: () => go("knowledge"),
          title: `${times(overview.waiting, "record")} not sent to the team yet`,
        });
      }
    } else segments.push({ key: "alone", content: "This machine only", open: () => go("team") });
    if (overview.paused > 0) {
      segments.push({
        key: "paused",
        content: [<Status key="tag" kind="warn" />, `${times(overview.paused, "session")} paused`],
        open: () => go("cost"),
      });
    }
  }
  const busy = working.find((what) => what !== null);

  return (
    <footer className="statusbar" data-state={working.length > 0 ? "working" : undefined}>
      <i className="statusbar-dot" aria-hidden="true" />
      <span className="statusbar-app">Grenier</span>
      <span aria-live="polite" className="contents">
        {busy && <span className="statusbar-busy">{busy}</span>}
        {saved && <span className="statusbar-busy">Saved</span>}
      </span>
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {(index > 0 || busy || saved) && <span className="statusbar-sep">·</span>}
          {segment.open ? (
            <button type="button" className="statusbar-segment" title={segment.title} onClick={segment.open}>
              {segment.content}
            </button>
          ) : (
            <span title={segment.title}>{segment.content}</span>
          )}
        </Fragment>
      ))}
      {prefs.tips && (
        <span className="statusbar-hints">
          {tries.length > 0 ? (
            <span className="statusbar-hint">
              <span className="text-muted">try</span>
              {tries.map((phrase, index) => (
                <Fragment key={phrase}>
                  {index > 0 && <span className="statusbar-sep">·</span>}“{phrase}”
                </Fragment>
              ))}
            </span>
          ) : (
            hints.map((hint) => (
              <span key={`${hint.keys}:${hint.says}`} className="statusbar-hint">
                <Keys shortcut={hint.keys} />
                {hint.says}
              </span>
            ))
          )}
        </span>
      )}
    </footer>
  );
}
