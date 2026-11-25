import type { ReactNode } from "react";

/**
 * Dense data in columns (components/table.md): a sticky header in the label role, 32 rows, numbers in mono on the
 * right (`num mono` on their cells), a totals row in `foot`. Its header sticks to the region that scrolls.
 */
export function Table({
  label,
  head,
  foot,
  children,
}: {
  label: string;
  head: ReactNode;
  foot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <table className="table" aria-label={label}>
      <thead>
        <tr>{head}</tr>
      </thead>
      <tbody>{children}</tbody>
      {foot && (
        <tfoot>
          <tr>{foot}</tr>
        </tfoot>
      )}
    </table>
  );
}

/** A row's actions, shown on hover and focus at its right end. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <td className="w-px">
      <div className="row-actions justify-end">{children}</div>
    </td>
  );
}
