import { useEffect, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type Run } from "../api.ts";
import { ago, Button, Empty, Loading, Notice, Page, Select, useAction, useLoad } from "../ui.tsx";

type Mode = "read-only" | "shadow" | "limited" | "on";
const MODES: Mode[] = ["read-only", "shadow", "limited", "on"];
const MODE_SAYS: Record<Mode, string> = {
  "read-only": "reads only",
  shadow: "says what it would do",
  limited: "acts, a set number of times a day",
  on: "acts within its tools",
};

interface RoutineView {
  id: string;
  title: string;
  author: string;
  trigger: string;
  schedule: string | null;
  repoHere: boolean;
  agent: string;
  collector: boolean;
  tools: string[];
  versions: { version: number; prompt: string; status: "testing" | "production" | "retired" }[];
  evals: number;
  approval: { mode: Mode; limit: number; current: boolean } | null;
}

interface LocalRun {
  id: string;
  routineId: string;
  version: number;
  trigger: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  actions: number;
  result: string | null;
}

const load = () => api<{ routines: RoutineView[] }>("/routines").then((answer) => answer.routines);
const loadRuns = () => api<{ runs: LocalRun[] }>("/runs").then((answer) => answer.runs);
const loadTeamRuns = () =>
  api<{ runs: Run[] }>("/team/runs")
    .then((answer) => answer.runs)
    .catch(() => [] as Run[]);

/** The mean eval score of each version, from the runs the team store kept. */
function scores(runs: Run[], routine: string): Map<number, number> {
  const sums = new Map<number, number[]>();
  for (const run of runs) {
    if (run.routine_id !== routine || run.kind !== "eval" || run.score === null) continue;
    sums.set(run.version, [...(sums.get(run.version) ?? []), run.score]);
  }
  return new Map([...sums].map(([version, list]) => [version, list.reduce((a, b) => a + b, 0) / list.length]));
}

/** The team's routines on this machine: approved by their hash, in a mode, with their versions, evals and runs. */
export function Routines(_: ViewProps) {
  const routines = useLoad(load);
  const runs = useLoad(loadRuns);
  const teamRuns = useLoad(loadTeamRuns);
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const action = useAction(() => {
    routines.reload();
    runs.reload();
    teamRuns.reload();
  });
  const going = runs.data?.some((run) => run.status === "running") ?? false;
  useEffect(() => {
    if (!going) return;
    const timer = window.setInterval(() => {
      runs.reload();
      teamRuns.reload();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [going, runs.reload, teamRuns.reload]);

  const call = (key: string, path: string, body: unknown, done: string, method = "POST") =>
    void action.run(key, async () => {
      await api(path, { method, body });
      return { text: done };
    });

  return (
    <Page
      title="Routines"
      intro="The team's factories for one kind of task. This machine runs one only once you approve it as it is, and only as far as its mode lets it: read-only first."
    >
      <Notice message={routines.error ?? action.message} />
      {!routines.data && !routines.error && <Loading what="routines" />}
      {routines.data?.length === 0 && (
        <Empty>
          <p>No routine yet. Write one as a Markdown file with its prompt, then:</p>
          <code>grenier routines add update-deps.md --repo .</code>
        </Empty>
      )}
      {routines.data?.map((routine) => {
        const scored = scores(teamRuns.data ?? [], routine.id);
        const mode = modes[routine.id] ?? routine.approval?.mode ?? "read-only";
        const mine = (runs.data ?? []).filter((run) => run.routineId === routine.id).slice(0, 5);
        return (
          <section key={routine.id} className="mb-7 rounded-xl border border-line bg-panel px-5 py-4">
            <header className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">{routine.title}</h2>
                <p className="mt-0.5 text-sm text-muted">
                  {routine.trigger === "schedule" ? `on a schedule, ${routine.schedule}` : `on ${routine.trigger}`} ·{" "}
                  {routine.agent} · by {routine.author}
                  {routine.collector && " · collector: runs on its person's machines, writes to their me"}
                  {!routine.repoHere && " · its repository is not on this machine"}
                </p>
                {routine.tools.length > 0 && (
                  <p className="mt-0.5 text-sm text-muted">Tools: {routine.tools.join(", ")}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Select
                  aria-label={`Mode of ${routine.title}`}
                  value={mode}
                  onChange={(event) => setModes({ ...modes, [routine.id]: event.currentTarget.value as Mode })}
                >
                  {MODES.map((name) => (
                    <option key={name} value={name}>
                      {name}: {MODE_SAYS[name]}
                    </option>
                  ))}
                </Select>
                <Button
                  disabled={action.busy !== null}
                  onClick={() =>
                    call(
                      `approve:${routine.id}`,
                      `/routines/${routine.id}/approve`,
                      { mode },
                      `Approved ${routine.title} here, ${mode}.`,
                    )
                  }
                >
                  {routine.approval?.current && routine.approval.mode === mode
                    ? "Approved"
                    : routine.approval && !routine.approval.current
                      ? "Approve the change"
                      : "Approve"}
                </Button>
              </div>
            </header>

            <div className="mt-3">
              <ul className="rounded-xl border border-line">
                {routine.versions.map((version) => (
                  <li
                    key={version.version}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t border-line px-4 py-2.5 first:border-t-0"
                  >
                    <div className="min-w-0">
                      <p>
                        <b className="font-semibold">v{version.version}</b> · {version.status}
                        {scored.has(version.version) &&
                          ` · eval score ${(scored.get(version.version) as number).toFixed(2)}`}
                      </p>
                      <p className="truncate text-sm text-muted" title={version.prompt}>
                        {version.prompt}
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button
                        quiet
                        disabled={action.busy !== null || going}
                        onClick={() =>
                          call(
                            `run:${routine.id}:${version.version}`,
                            `/routines/${routine.id}/run`,
                            { version: version.version },
                            `Running v${version.version} of ${routine.title} here.`,
                          )
                        }
                      >
                        Run now
                      </Button>
                      {routine.evals > 0 && (
                        <Button
                          quiet
                          disabled={action.busy !== null || going}
                          onClick={() =>
                            call(
                              `eval:${routine.id}:${version.version}`,
                              `/routines/${routine.id}/eval`,
                              { version: version.version },
                              `Running the ${routine.evals} evals of v${version.version}.`,
                            )
                          }
                        >
                          Run evals
                        </Button>
                      )}
                      {version.status === "testing" && (
                        <Button
                          disabled={action.busy !== null}
                          onClick={() =>
                            call(
                              `promote:${routine.id}:${version.version}`,
                              `/routines/${routine.id}/promote`,
                              { version: version.version },
                              `v${version.version} of ${routine.title} is in production.`,
                            )
                          }
                        >
                          Promote
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-sm text-muted">
                {routine.evals === 0
                  ? "No eval set yet: a thumbs up or down on a run adds one."
                  : `${routine.evals} eval cases. A version reaches production only when it scores at least as well as the one there.`}
              </p>
            </div>

            {mine.length > 0 && (
              <ul className="mt-3 border-t border-line pt-2">
                {mine.map((run) => (
                  <li key={run.id} className="py-1.5">
                    <p className="text-sm">
                      <b className="font-semibold">{run.status}</b> · v{run.version} · {run.trigger} ·{" "}
                      {ago(run.startedAt)}
                      {run.actions > 0 ? ` · ${run.actions} actions` : ""}
                    </p>
                    {run.result && (
                      <p className="mt-0.5 line-clamp-3 text-sm whitespace-pre-wrap text-muted">{run.result}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </Page>
  );
}
