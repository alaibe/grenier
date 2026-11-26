import type { RoutineView, Run } from "@grenier/core/api";
import { api } from "../api.ts";
import { ago, exact, money } from "../format.ts";
import { stateTag } from "../states.ts";
import { useLoad } from "../ui/load.ts";
import { Section } from "../ui/page.tsx";
import { Table } from "../ui/table.tsx";
import { Status } from "../ui/tag.tsx";

const loadRuns = () =>
  api<{ runs: Run[] }>("/team/runs")
    .then((answer) => answer.runs)
    .catch(() => [] as Run[]);

/** For Routines: the runs of the team's routines on every machine, with what they cost. */
export function TeamRuns({ routines }: { routines: readonly RoutineView[] }) {
  const runs = useLoad(loadRuns);
  if (!runs.data || runs.data.length === 0) return null;
  const names = new Map(routines.map((routine) => [routine.id, routine.title]));
  const nameOf = (id: string) => names.get(id) ?? "a routine";
  return (
    <Section heading title="Runs" description="The last runs of the team's routines, on every machine.">
      <Table
        label="Runs"
        head={
          <>
            <th>Routine</th>
            <th>Machine</th>
            <th>State</th>
            <th>Started</th>
            <th className="num">Actions</th>
            <th className="num">API cost</th>
          </>
        }
        foot={
          <>
            <td colSpan={4}>Total</td>
            <td className="num">{runs.data.reduce((sum, run) => sum + run.actions, 0)}</td>
            <td className="num">{money(runs.data.reduce((sum, run) => sum + run.cost, 0))}</td>
          </>
        }
      >
        {runs.data.map((run) => (
          <tr key={run.id}>
            <td>{nameOf(run.routine_id)}</td>
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
