import type { ReactNode } from "react";

/** Two to four key numbers in one bordered row (components/stat-and-chart.md). */
export function Stats({ children, columns }: { children: ReactNode; columns: 2 | 3 | 4 }) {
  return (
    <div className="stats" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {children}
    </div>
  );
}

/** One number with its label; `lit` for the one the screen is about. */
export function Stat({
  label,
  value,
  change,
  lit = false,
}: {
  label: string;
  value: ReactNode;
  change?: ReactNode;
  lit?: boolean;
}) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={lit ? "stat-value stat-key" : "stat-value"}>{value}</span>
      {change && <span className="stat-change">{change}</span>}
    </div>
  );
}
