import type { RecordRow, Run } from "@grenier/core/api";
import { taskFor } from "@grenier/core/routines";
import { useCallback, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { ago, exact, money } from "../format.ts";
import { routineTitle, takesRequests } from "../requests.ts";
import { stateTag } from "../states.ts";
import { Button } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Skeleton } from "../ui/empty.tsx";
import { Field, Input, Select, Textarea } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { Table } from "../ui/table.tsx";
import { Status } from "../ui/tag.tsx";

const loadRoutines = () => api<{ records: RecordRow[] }>("/records?type=Routine").then((answer) => answer.records);
const loadTasks = () =>
  api<{ records: RecordRow[] }>("/records?type=Task").then((answer) =>
    answer.records.filter((record) => typeof record.fields.routine === "string" && record.fields.routine !== ""),
  );
const loadRuns = () =>
  api<{ runs: Run[] }>("/team/runs")
    .then((answer) => answer.runs)
    .catch(() => [] as Run[]);

/** For Routines: asking a routine for work, and what came of it. */
export function Requests({ go, member }: Pick<ViewProps, "go" | "member">) {
  const routines = useLoad(loadRoutines);
  const tasks = useLoad(loadTasks);
  const runs = useLoad(loadRuns);
  const [filing, setFiling] = useState(false);
  const action = useAction(() => {
    tasks.reload();
    runs.reload();
    setFiling(false);
  });
  const nameOf = useCallback((id: unknown) => routineTitle(routines.data, id), [routines.data]);
  const requestable = routines.data?.filter(takesRequests) ?? [];

  return (
    <Section
      heading
      title="Requests"
      description={
        member
          ? "What the team asked its routines for, and what came of it."
          : "Ask a routine for work: an idle machine that allows it runs it, read-only until the routine is trusted."
      }
      actions={
        !member &&
        requestable.length > 0 && (
          <Button size="sm" onClick={() => setFiling(true)}>
            File a request…
          </Button>
        )
      }
    >
      <div className="grid gap-6">
        <Problem error={routines.error ?? tasks.error} />
        {!tasks.data && !tasks.error && <Skeleton rows={3} shape="table" />}
        {tasks.data?.length === 0 && <p className="text-muted">No request yet.</p>}
        {tasks.data && tasks.data.length > 0 && (
          <Table
            label="Requests filed"
            head={
              <>
                <th>Request</th>
                <th>Routine</th>
                <th>State</th>
                <th>Machine</th>
                <th>Changed</th>
              </>
            }
          >
            {tasks.data.map((task) => (
              <tr key={task.id}>
                <td className="whitespace-normal">
                  <a
                    className="hover:underline"
                    href={`#knowledge/${encodeURIComponent(task.id)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      go("knowledge", task.id);
                    }}
                  >
                    {task.title}
                  </a>
                </td>
                <td>{nameOf(task.fields.routine)}</td>
                <td>
                  <Status {...stateTag(String(task.fields.status ?? "to-do"))} />
                </td>
                <td>{String(task.fields.machine ?? "")}</td>
                <td className="mono">
                  <time title={exact(task.updatedAt)}>{ago(task.updatedAt)}</time>
                </td>
              </tr>
            ))}
          </Table>
        )}

        {runs.data && runs.data.length > 0 && (
          <Section title="Runs">
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
        )}
      </div>
      {filing && (
        <Dialog
          wide
          title="File a request"
          action="File the request"
          busy={action.busy !== null}
          onCancel={() => setFiling(false)}
          onAction={(form) => {
            const routine = requestable.find((entry) => entry.id === form.get("routine"));
            if (!routine) return;
            void action.run("file", async () => {
              await api("/records", {
                body: taskFor(routine, String(form.get("title") ?? ""), String(form.get("details") ?? "")),
              });
              return "Filed the request: the first idle machine that allows this routine takes it";
            });
          }}
        >
          <Problem error={action.problem} />
          <Field label="Routine">
            <Select name="routine" required>
              {requestable.map((routine) => (
                <option key={routine.id} value={routine.id}>
                  {routine.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="What to do">
            <Input name="title" required placeholder="Bump hono to the latest version" />
          </Field>
          <Field label="Details" help="Optional: anything the agent should know.">
            <Textarea name="details" rows={4} />
          </Field>
        </Dialog>
      )}
    </Section>
  );
}
