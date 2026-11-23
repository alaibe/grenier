import { type FormEvent, useCallback } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type RecordRow, type Run } from "../api.ts";
import {
  ago,
  Button,
  Empty,
  Field,
  Input,
  Loading,
  money,
  Notice,
  Part,
  Select,
  Table,
  useAction,
  useLoad,
} from "../ui.tsx";

const loadRoutines = () =>
  api<{ records: RecordRow[] }>("/records?type=Routine").then((answer) =>
    answer.records.filter((record) => (record.fields.trigger ?? "request") === "request"),
  );
const loadTasks = () =>
  api<{ records: RecordRow[] }>("/records?type=Task").then((answer) =>
    answer.records.filter((record) => typeof record.fields.routine === "string" && record.fields.routine !== ""),
  );
const loadRuns = () =>
  api<{ runs: Run[] }>("/team/runs")
    .then((answer) => answer.runs.filter((run) => run.kind === "run"))
    .catch(() => [] as Run[]);

/** For Routines: asking a routine for work, and what came of it. */
export function Requests({ go }: Pick<ViewProps, "go">) {
  const routines = useLoad(loadRoutines);
  const tasks = useLoad(loadTasks);
  const runs = useLoad(loadRuns);
  const action = useAction(() => {
    tasks.reload();
    runs.reload();
  });
  const routineTitle = useCallback(
    (id: unknown) => routines.data?.find((routine) => routine.id === id)?.title ?? "a routine",
    [routines.data],
  );

  const file = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void action.run("file", async () => {
      await api("/records", {
        body: {
          type: "Task",
          space: "team",
          title: String(data.get("title") ?? ""),
          body: String(data.get("details") ?? ""),
          fields: { status: "to-do", routine: String(data.get("routine") ?? "") },
        },
      });
      form.reset();
      return { text: "Filed. The first idle machine that allows this routine takes it." };
    });
  };

  const thumbs = (run: Run, up: boolean) =>
    void action.run(`thumbs:${run.id}`, async () => {
      await api(`/runs/${encodeURIComponent(run.id)}/thumbs`, { body: { up } });
      return undefined;
    });

  if (routines.data?.length === 0) return null;
  return (
    <Part
      title="Requests"
      intro="Ask a routine for work. Its task goes to the team's store, and an idle machine that allows the routine runs it, read-only until the routine is trusted."
    >
      <Notice message={routines.error ?? tasks.error ?? action.message} />
      {routines.data && routines.data.length > 0 && (
        <form
          className="mb-7 grid grid-cols-[200px_1fr] gap-3 rounded-xl border border-line bg-panel px-5 py-4"
          onSubmit={file}
        >
          <Field>
            Routine
            <Select name="routine" required>
              {routines.data.map((routine) => (
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
          <div className="col-span-full">
            <Field>
              Details (optional)
              <textarea name="details" className="min-h-20 rounded-md border border-line-strong bg-panel px-2.5 py-2" />
            </Field>
          </div>
          <div className="col-span-full">
            <Button type="submit" disabled={action.busy !== null}>
              File the request
            </Button>
          </div>
        </form>
      )}

      <h3 className="mb-2.5 font-semibold">Filed</h3>
      {!tasks.data && !tasks.error && <Loading what="requests" />}
      {tasks.data?.length === 0 && <Empty>No request yet.</Empty>}
      {tasks.data && tasks.data.length > 0 && (
        <div className="mb-7">
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
                  <td>{routineTitle(task.fields.routine)}</td>
                  <td>{String(task.fields.status ?? "to-do")}</td>
                  <td>{String(task.fields.machine ?? "")}</td>
                  <td className="whitespace-nowrap">{ago(task.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      {runs.data && runs.data.length > 0 && (
        <>
          <h3 className="mb-2.5 font-semibold">Runs</h3>
          <Table>
            <thead>
              <tr>
                <th>Routine</th>
                <th>Machine</th>
                <th>Status</th>
                <th>Started</th>
                <th className="text-right tabular-nums">Actions</th>
                <th className="text-right tabular-nums">API cost</th>
                <th title="A yes or a no adds the run to the routine's eval set">Useful?</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((run) => (
                <tr key={run.id}>
                  <td>
                    {routineTitle(run.routine_id)} <span className="text-sm text-muted">v{run.version}</span>
                  </td>
                  <td>{run.machine}</td>
                  <td>{run.status}</td>
                  <td className="whitespace-nowrap">{ago(run.started_at)}</td>
                  <td className="text-right tabular-nums">{run.actions}</td>
                  <td className="text-right tabular-nums">{money(run.cost)}</td>
                  <td className="whitespace-nowrap">
                    <Button
                      quiet
                      aria-pressed={run.thumbs === 1}
                      className={run.thumbs === 1 ? "mr-1 inset-ring inset-ring-accent" : "mr-1"}
                      disabled={action.busy !== null}
                      onClick={() => thumbs(run, true)}
                    >
                      Yes
                    </Button>
                    <Button
                      quiet
                      aria-pressed={run.thumbs === -1}
                      className={run.thumbs === -1 ? "inset-ring inset-ring-accent" : ""}
                      disabled={action.busy !== null}
                      onClick={() => thumbs(run, false)}
                    >
                      No
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </Part>
  );
}
