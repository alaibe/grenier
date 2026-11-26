import type { Run } from "@grenier/core/api";
import { useCallback } from "react";
import { api } from "../api.ts";
import { ago, exact, money } from "../format.ts";
import { stateTag } from "../states.ts";
import { useLoad } from "../ui/load.ts";
import { Section } from "../ui/page.tsx";
import { Table } from "../ui/table.tsx";
import { Status } from "../ui/tag.tsx";

/** For a routine: its last runs on every machine of the team, with what they cost. */
export function TeamRuns({ routine }: { routine: string }) {
  const load = useCallback(
    () =>
      api<{ runs: Run[] }>(`/team/runs?routine=${encodeURIComponent(routine)}`)
        .then((answer) => answer.runs)
        .catch(() => [] as Run[]),
    [routine],
  );
  const runs = useLoad(load).data;
  if (!runs || runs.length === 0) return null;
  return (
    <Section heading title="Runs on the team" description="Its last runs, on every machine.">
      <Table
        label="Runs on the team"
        head={
          <>
            <th>Machine</th>
            <th>State</th>
            <th>Started</th>
            <th className="num">Actions</th>
            <th className="num">API cost</th>
          </>
        }
        foot={
          <>
            <td colSpan={3}>Total</td>
            <td className="num">{runs.reduce((sum, run) => sum + run.actions, 0)}</td>
            <td className="num">{money(runs.reduce((sum, run) => sum + run.cost, 0))}</td>
          </>
        }
      >
        {runs.map((run) => (
          <tr key={run.id}>
            <td>{run.machine}</td>
            <td>
              <Status {...stateTag(run.status)} />
            </td>
            <td className="mono">
              <time title={exact(run.started_at)}>{ago(run.started_at)}</time>
            </td>
            <td className="num mono">{run.actions}</td>
            <td className="num mono">{money(run.cost)}</td>
          </tr>
        ))}
      </Table>
    </Section>
  );
}
