import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "./button.tsx";
import { Status, type StatusKind } from "./tag.tsx";

type Kind = "info" | "ok" | "warn" | "err" | "accent";

const BAR: Record<Kind, string> = {
  info: "notice-info",
  ok: "notice-success",
  warn: "notice-warning",
  err: "notice-danger",
  accent: "notice-accent",
};

const TAG: Record<Exclude<Kind, "accent">, StatusKind> = { info: "info", ok: "ok", warn: "warn", err: "err" };

/**
 * A message that stays on the page until what it says is resolved (components/notice.md). It never toasts: brief
 * feedback after an action is `useToast`. An accent notice is the app's own (an approval waiting) and names its tag.
 */
export function Notice({
  kind,
  tag,
  children,
  more,
  action,
  onDismiss,
  banner = false,
}: {
  kind: Kind;
  /** The accent notice's word: NEW, WAITING. */
  tag?: string;
  children: ReactNode;
  /** A second line, in muted. */
  more?: ReactNode;
  /** At most one: a secondary `sm` button. */
  action?: ReactNode;
  /** Only when it can go without anything being fixed. */
  onDismiss?: () => void;
  banner?: boolean;
}) {
  return (
    <div className={`notice ${BAR[kind]}${banner ? " notice-banner" : ""}`} role={kind === "err" ? "alert" : "status"}>
      {kind === "accent" ? <span className="tag tag-accent">{tag ?? "NEW"}</span> : <Status kind={TAG[kind]} />}
      <div className="notice-text">
        <p>{children}</p>
        {more && <p className="notice-more">{more}</p>}
      </div>
      {action}
      {onDismiss && <IconButton label="Dismiss" icon={X} size="sm" onClick={onDismiss} />}
    </div>
  );
}

/** A problem that stays until it is fixed or retried, or nothing when there is none. */
export function Problem({ error, action }: { error: string | null | undefined; action?: ReactNode }) {
  if (!error) return null;
  return (
    <Notice kind="err" action={action}>
      {error}
    </Notice>
  );
}
