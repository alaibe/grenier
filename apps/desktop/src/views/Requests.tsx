import type { RecordRow, Run } from "@grenier/core/api";
import { taskFor } from "@grenier/core/routines";
import { type FormEvent, useCallback } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { routineTitle, takesRequests } from "../requests.ts";
import {
  Actions,
  ago,
  Button,
  Empty,
  Field,
  FormCard,
  Input,
  Loading,
  money,
  Notice,
  Part,
  Section,
  Select,
  Table,
  Textarea,
  useAction,
  useLoad,
} from "../ui.tsx";

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
  const action = useAction(() => {
    tasks.reload();
    runs.reload();
  });
  const nameOf = useCallback((id: unknown) => routineTitle(routines.data, id), [routines.data]);
  const requestable = routines.data?.filter(takesRequests) ?? [];

  const file = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const routine = requestable.find((entry) => entry.id === data.get("routine"));
    if (!routine) return;
    void action.run("file", async () => {
      await api("/records", {
        body: taskFor(routine, String(data.get("title") ?? ""), String(data.get("details") ?? "")),
      });
      form.reset();
      return { text: "Filed. The first idle machine that allows this routine takes it." };
    });
  };

  if (routines.data?.length === 0) return null;
  return (
    <Part
      title="Requests"
      intro={
        member
          ? "What the team asked its routines for, and what came of it."
          : "Ask a routine for work. Its task goes to the team's store, and an idle machine that allows the routine runs it, read-only until the routine is trusted."
      }
    >
      <Notice message={routines.error ?? tasks.error ?? action.message} />
      {!member && requestable.length > 0 && (
        <FormCard className="grid-cols-[200px_1fr]" onSubmit={file}>
          <Field>
            Routine
            <Select name="routine" required>
              {requestable.map((routine) => (
                <option key={routine.id} value={routine.id}>
                  {routine.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field>
            What to do
            <Input name="title" required placeholder="Bump hono to the latest version" />
          </Field>
          <Field className="col-span-full">
            Details (optional)
            <Textarea name="details" className="min-h-20" />
          </Field>
          <Actions className="col-span-full">
            <Button type="submit" disabled={action.busy !== null}>
              File the request
            </Button>
          </Actions>
        </FormCard>
      )}

      <Section title="Filed">
        {!tasks.data && !tasks.error && <Loading what="requests" />}
        {tasks.data?.length === 0 && <Empty>No request yet.</Empty>}
        {tasks.data && tasks.data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>Request</th>
                <th>Routine</th>
                <th>Status</th>
                <th>Machine</th>
                <th>Changed</th>
              </tr>
            </thead>
            <tbody>
              {tasks.data.map((task) => (
                <tr key={task.id}>
                  <td>
                    <button
                      type="button"
                      className="cursor-pointer text-left font-medium hover:underline"
                      onClick={() => go("knowledge", task.id)}
                    >
                      {task.title}
                    </button>
                  </td>
                  <td>{nameOf(task.fields.routine)}</td>
                  <td>{String(task.fields.status ?? "to-do")}</td>
                  <td>{String(task.fields.machine ?? "")}</td>
                  <td className="whitespace-nowrap">{ago(task.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      {runs.data && runs.data.length > 0 && (
        <Section title="Runs">
          <Table>
            <thead>
              <tr>
                <th>Routine</th>
                <th>Machine</th>
                <th>Status</th>
                <th>Started</th>
                <th className="text-right tabular-nums">Actions</th>
                <th className="text-right tabular-nums">API cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((run) => (
                <tr key={run.id}>
                  <td>{nameOf(run.routine_id)}</td>
                  <td>{run.machine}</td>
                  <td>{run.status}</td>
                  <td className="whitespace-nowrap">{ago(run.started_at)}</td>
                  <td className="text-right tabular-nums">{run.actions}</td>
                  <td className="text-right tabular-nums">{money(run.cost)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Section>
      )}
    </Part>
  );
}
