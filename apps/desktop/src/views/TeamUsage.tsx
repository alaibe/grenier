import type { TeamUsage } from "@grenier/core/api";
import { useCallback, useState } from "react";
import { api } from "../api.ts";
import { money } from "../format.ts";
import { useLoad } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { Table } from "../ui/table.tsx";

export type By = "member" | "machine" | "day" | "repo";

/** What the agents cost, priced at API rates: an admin sees everyone's, a member their own. */
export function Usage({ admin }: { admin: boolean }) {
  const [by, setBy] = useState<By>(admin ? "member" : "machine");
  const { data, error } = useLoad(
    useCallback(() => api<{ usage: TeamUsage[] }>("/team/usage").then((a) => a.usage), []),
  );
  if (error) return <Problem error={error} />;
  if (!data) return null;
  const rows = new Map<string, { requests: number; cost: number; minutes: number }>();
  for (const row of data) {
    const key = row[by] || "(no repository)";
    const total = rows.get(key) ?? { requests: 0, cost: 0, minutes: 0 };
    rows.set(key, {
      requests: total.requests + row.requests,
      cost: total.cost + row.cost,
      minutes: total.minutes + row.routine_minutes,
    });
  }
  const totals = [...rows.values()].reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      cost: sum.cost + row.cost,
      minutes: sum.minutes + row.minutes,
    }),
    { requests: 0, cost: 0, minutes: 0 },
  );
  const options = (admin ? (["member", "machine", "day", "repo"] as const) : (["machine", "day", "repo"] as const)).map(
    (name) => [name, name === "repo" ? "Repository" : name[0]?.toUpperCase() + name.slice(1)] as const,
  );
  return (
    <Section
      heading
      title={admin ? "Usage" : "Your usage"}
      description="The last 30 days, priced at API rates."
      actions={<Segmented label="Group by" options={options} value={by} onChange={setBy} />}
    >
      {rows.size === 0 ? (
        <p className="text-muted">No usage reported yet.</p>
      ) : (
        <Table
          label="Usage"
          head={
            <>
              <th>{options.find(([key]) => key === by)?.[1]}</th>
              <th className="num">Requests</th>
              <th className="num">Routine minutes</th>
              <th className="num">API cost</th>
            </>
          }
          foot={
            <>
              <td>Total</td>
              <td className="num">{totals.requests}</td>
              <td className="num">{Math.round(totals.minutes)}</td>
              <td className="num">{money(totals.cost)}</td>
            </>
          }
        >
          {[...rows.entries()]
            .sort(([a, x], [b, y]) => (by === "day" ? b.localeCompare(a) : y.cost - x.cost))
            .map(([key, total]) => (
              <tr key={key}>
                <td className={by === "day" || by === "machine" ? "mono" : undefined}>{key}</td>
                <td className="num mono">{total.requests}</td>
                <td className="num mono">{Math.round(total.minutes)}</td>
                <td className="num mono">{money(total.cost)}</td>
              </tr>
            ))}
        </Table>
      )}
    </Section>
  );
}
