import { type ReactNode, useEffect, useState } from "react";
import { LitPoint } from "./brand.tsx";

/**
 * A place with nothing in it (components/empty-state.md): the lit point, a boot line of three words or fewer, one
 * sentence, at most one button. A search that found nothing has no lit point and says `> no match`.
 */
export function Empty({
  boot,
  children,
  action,
  match = false,
}: {
  /** Lowercase, three words or fewer: "no pages yet". */
  boot: string;
  /** One sentence: what this place is for and how things arrive. */
  children: ReactNode;
  /** The one action that fills the place. */
  action?: ReactNode;
  /** No search result: no lit point, no texture. */
  match?: boolean;
}) {
  return (
    <section className={match ? "grid place-items-center" : "empty-region"}>
      <div className="empty">
        {!match && <LitPoint />}
        <p className="empty-boot">
          <span className="empty-prompt">&gt;</span> {boot}
          <span className="empty-cursor" aria-hidden="true" />
        </p>
        <p className="empty-text">{children}</p>
        {action}
      </div>
    </section>
  );
}

/** Rows of blocks in the shape of what loads, shown only once it takes long enough to notice. */
export function Skeleton({ rows = 3, shape = "row" }: { rows?: number; shape?: "row" | "table" | "text" }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  const widths = ["62%", "48%", "71%", "55%", "40%", "66%", "52%", "60%", "45%", "68%"].slice(0, rows);
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className={shape === "table" ? "border-t border-line" : ""}
    >
      {widths.map((width) => (
        <div
          key={width}
          className={shape === "text" ? "py-1.5" : "flex h-8 items-center gap-3 border-b border-line px-3"}
        >
          <span className="skeleton" style={{ width }} />
          {shape === "table" && <span className="skeleton ml-auto w-16" />}
        </div>
      ))}
    </div>
  );
}
