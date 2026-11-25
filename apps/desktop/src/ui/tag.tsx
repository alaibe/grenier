import type { ReactNode } from "react";

/** A category: a scope, a record's type, a role (components/tag.md). */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

export type StatusKind = "ok" | "warn" | "err" | "info" | "live" | "draft";

const LOOK: Record<StatusKind, [string, string]> = {
  ok: ["OK", "tag tag-ok"],
  warn: ["WARN", "tag tag-warn"],
  err: ["ERR", "tag tag-err"],
  info: ["INFO", "tag tag-info"],
  live: ["LIVE", "tag tag-accent"],
  draft: ["DRAFT", "tag"],
};

/** A state as a word, so it never rests on colour alone; `word` names it in the app's terms. */
export function Status({ kind, word }: { kind: StatusKind; word?: string }) {
  const [standard, look] = LOOK[kind];
  return (
    <span className={look}>
      {kind === "live" && <i className="tag-dot" aria-hidden="true" />}
      {word ?? standard}
    </span>
  );
}
