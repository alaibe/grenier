import type { LocalRun, MachineState, RoutineView } from "@grenier/core/api";
import type { RoutineMode } from "@grenier/core/routines";
import { ArrowRight, Check, Pencil, Play, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { ago, exact } from "../format.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { Detail } from "../shell/regions.tsx";
import { stateTag } from "../states.ts";
import { Button, Primary } from "../ui/button.tsx";
import { Checkbox } from "../ui/choice.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { Field, Input, Select, Textarea } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Notice, Problem } from "../ui/notice.tsx";
import { Page, Section } from "../ui/page.tsx";
import { Table } from "../ui/table.tsx";
import { Status } from "../ui/tag.tsx";
import { usePolling } from "./polling.ts";
import { TeamRuns } from "./TeamRuns.tsx";

const MODES: RoutineMode[] = ["read-only", "shadow", "limited", "on"];
const MODE_SAYS: Record<RoutineMode, string> = {
  "read-only": "reads only",
  shadow: "says what it would do",
  limited: "acts, a set number of times a day",
  on: "acts, auto mode judging each step",
};

const load = () => api<{ routines: RoutineView[] }>("/routines").then((answer) => answer.routines);
const loadRuns = () => api<{ runs: LocalRun[] }>("/runs").then((answer) => answer.runs);
const loadWorkdir = () => api<MachineState>("/machine").then((machine) => machine.rules.workdir);

const WHEN: [string, string][] = [
  ["hand", "Only when run by hand"],
  ["hourly", "Every hour"],
  ["daily", "Every day"],
  ["weekdays", "On weekdays"],
  ["mon", "Every Monday"],
  ["tue", "Every Tuesday"],
  ["wed", "Every Wednesday"],
  ["thu", "Every Thursday"],
  ["fri", "Every Friday"],
  ["sat", "Every Saturday"],
  ["sun", "Every Sunday"],
];

/** A routine's name, text, schedule and agent: a new one, or one changed in place. */
function RoutineForm({
  routine,
  done,
  cancel,
}: {
  routine?: RoutineView | undefined;
  done: () => void;
  cancel: () => void;
}) {
  const [day, time] = routine?.schedule ? routine.schedule.split(" ") : [];
  const [when, setWhen] = useState(routine?.schedule ? (day ?? "daily") : "hand");
  const action = useAction(done);
  return (
    <Dialog
      wide
      title={routine ? `Edit ${routine.title}` : "New routine"}
      action={routine ? "Save the routine" : "Add the routine"}
      busy={action.busy !== null}
      onCancel={cancel}
      onAction={(form) =>
        void action.run("routine", async () => {
          await api(routine ? `/routines/${routine.id}` : "/routines", {
            method: routine ? "PUT" : "POST",
            body: {
              title: String(form.get("title") ?? ""),
              prompt: String(form.get("prompt") ?? ""),
              schedule:
                when === "hand" ? "" : when === "hourly" ? "hourly" : `${when} ${String(form.get("time") ?? "05:00")}`,
              agent: String(form.get("agent") ?? "claude"),
              collector: form.get("collector") === "on",
            },
          });
          return routine ? `Saved ${String(form.get("title"))}` : `Added ${String(form.get("title"))}`;
        })
      }
    >
      <Problem error={action.problem} />
      <Field label="Name">
        <Input name="title" placeholder="Update dependencies" defaultValue={routine?.title} required />
      </Field>
      <Field label="Prompt" help="What the agent is asked to do, each time it runs.">
        <Textarea
          name="prompt"
          rows={5}
          required
          defaultValue={routine?.prompt}
          placeholder="Bump the dependencies to their latest release, run the tests, and explain what changed."
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="When">
          <Select value={when} onChange={(event) => setWhen(event.currentTarget.value)}>
            {WHEN.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        {when !== "hand" && when !== "hourly" ? (
          <Field label="At, in UTC">
            <Input name="time" type="time" mono defaultValue={time ?? "05:00"} required />
          </Field>
        ) : (
          <span />
        )}
        <Field label="Agent">
          <Select name="agent" defaultValue={routine?.agent ?? "claude"}>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </Select>
        </Field>
      </div>
      <Checkbox
        name="collector"
        defaultChecked={routine?.collector}
        label="Each person's own"
        description="It runs on each person's machines and writes to their Me."
      />
    </Dialog>
  );
}

export function Routines({ item, go, member, team }: ViewProps) {
  const routines = useLoad(load);
  const runs = useLoad(loadRuns);
  const workdir = useLoad(loadWorkdir);
  // Routines run on the team's machines: without a team there is nowhere to add one.
  const adding = !member && Boolean(team);
  const [modes, setModes] = useState<Record<string, RoutineMode>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const action = useAction(() => {
    routines.reload();
    runs.reload();
  });
  const going = runs.data?.some((run) => run.status === "running") ?? false;
  usePolling(runs.reload, going ? 3000 : null);

  const call = (key: string, path: string, body: unknown, done: string, working?: string) =>
    void action.run(
      key,
      async () => {
        await api(path, { body });
        return done;
      },
      working,
    );
  const closeForm = () => {
    setEditing(null);
    if (item === "new") go("routines");
  };
  const saved = () => {
    closeForm();
    routines.reload();
  };
  const librarian = routines.data && !routines.data.some((routine) => routine.title === "Librarian");

  // biome-ignore lint/correctness/useExhaustiveDependencies: call reads the action as it is when it runs
  const commands = useMemo<Command[]>(
    () => [
      ...(adding
        ? [
            {
              id: "new-routine",
              label: "New routine",
              icon: Plus,
              keys: "n",
              also: ["mod+n"],
              hint: { in: "list" as const, says: "new", order: 20 },
              run: () => go("routines", "new"),
            },
          ]
        : []),
      ...(routines.data ?? [])
        .filter((routine) => routine.approval?.current && routine.prompt.trim())
        .map((routine) => ({
          id: `run:${routine.id}`,
          label: `Run ${routine.title}`,
          icon: Play,
          run: () =>
            call(`run:${routine.id}`, `/routines/${routine.id}/run`, {}, `Running ${routine.title} here`, "Starting"),
        })),
    ],
    [adding, routines.data, go],
  );
  useCommands(commands);

  return (
    <Detail title="Routines">
      <Page
        title="Routines"
        intro="Tasks the team's machines run, each from its text. This machine runs one only once you approve it as it is, and only as far as its mode lets it: read-only first."
        actions={
          adding &&
          librarian && (
            <Button
              icon={Plus}
              disabled={action.busy !== null}
              title="A built-in routine that looks through the store each day and suggests fixes"
              onClick={() =>
                call("librarian", "/routines/librarian", {}, "Added the librarian: it runs each day at 05:00 UTC")
              }
            >
              Add the librarian
            </Button>
          )
        }
        primary={
          adding && (
            <Primary keys="n" onClick={() => go("routines", "new")}>
              New routine…
            </Primary>
          )
        }
      >
        <Problem error={routines.error ?? action.problem} />
        {workdir.data === "" && (
          <Notice
            kind="accent"
            tag="SET UP"
            action={
              <Button size="sm" trailing={ArrowRight} onClick={() => go("settings", "machine")}>
                Set the work folder
              </Button>
            }
          >
            Routines run in this machine's work folder, the one that holds your projects. Set it first.
          </Notice>
        )}
        {!routines.data && !routines.error && <Skeleton rows={5} />}
        {routines.data?.length === 0 &&
          (team === null && !member ? (
            <Empty
              boot="no team yet"
              action={
                <Primary trailing={ArrowRight} onClick={() => go("team")}>
                  Create a team
                </Primary>
              }
            >
              Routines run through a team's store, which hands their work to its machines. A team can be just you, in
              your own Cloudflare account.
            </Empty>
          ) : (
            <Empty boot="no routines yet">
              {member
                ? "The team has no routine yet: an admin adds them."
                : "Start one with New routine, or add the librarian."}
            </Empty>
          ))}
        {routines.data?.map((routine) => (
          <Routine
            key={routine.id}
            routine={routine}
            runs={(runs.data ?? []).filter((run) => run.routineId === routine.id).slice(0, 5)}
            mode={modes[routine.id] ?? routine.approval?.mode ?? "read-only"}
            setMode={(mode) => setModes({ ...modes, [routine.id]: mode })}
            busy={action.busy !== null}
            going={going}
            member={member}
            approve={(mode) =>
              call(
                `approve:${routine.id}`,
                `/routines/${routine.id}/approve`,
                { mode },
                `Approved ${routine.title} here, ${mode}`,
              )
            }
            run={() =>
              call(`run:${routine.id}`, `/routines/${routine.id}/run`, {}, `Running ${routine.title} here`, "Starting")
            }
            edit={() => setEditing(routine.id)}
          />
        ))}
        {routines.data && routines.data.length > 0 && team && <TeamRuns routines={routines.data} />}
      </Page>
      {(item === "new" && adding) || editing ? (
        <RoutineForm
          {...(editing ? { routine: routines.data?.find((routine) => routine.id === editing) } : {})}
          done={saved}
          cancel={closeForm}
        />
      ) : null}
    </Detail>
  );
}

function Routine({
  routine,
  runs,
  mode,
  setMode,
  busy,
  going,
  member,
  approve,
  run,
  edit,
}: {
  routine: RoutineView;
  runs: LocalRun[];
  mode: RoutineMode;
  setMode: (mode: RoutineMode) => void;
  busy: boolean;
  going: boolean;
  member: boolean;
  approve: (mode: RoutineMode) => void;
  run: () => void;
  edit: () => void;
}) {
  const approved = routine.approval?.current && routine.approval.mode === mode;
  const when = routine.schedule ? `on a schedule, ${routine.schedule}` : "run by hand";
  return (
    <Section
      heading
      title={routine.title}
      description={`${when} · ${routine.agent} · by ${routine.author}${routine.collector ? " · each person's own" : ""}`}
      actions={
        <>
          <div className="w-64">
            <Select
              aria-label={`Mode of ${routine.title}`}
              value={mode}
              onChange={(event) => setMode(event.currentTarget.value as RoutineMode)}
            >
              {MODES.map((name) => (
                <option key={name} value={name}>
                  {name}: {MODE_SAYS[name]}
                </option>
              ))}
            </Select>
          </div>
          {approved ? (
            <Status kind="ok" word="approved" />
          ) : (
            <Button icon={Check} disabled={busy || !routine.prompt.trim()} onClick={() => approve(mode)}>
              {routine.approval && !routine.approval.current ? "Approve the change" : "Approve"}
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-3">
        <p className="line-clamp-4 max-w-(--layout-reading) whitespace-pre-wrap" title={routine.prompt}>
          {routine.prompt.trim() || (
            <span className="text-muted">No text yet: it runs nowhere until an admin writes what it does.</span>
          )}
        </p>
        {routine.approval && !routine.approval.current && (
          <Notice kind="warn">Changed since you approved it: it runs here again once you approve the change.</Notice>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            icon={Play}
            size="sm"
            disabled={busy || going || !routine.prompt.trim() || !routine.approval?.current}
            title={routine.approval?.current ? undefined : "Approve it as it is now to run it here"}
            onClick={run}
          >
            Run now
          </Button>
          {!member && (
            <Button icon={Pencil} size="sm" onClick={edit}>
              Edit
            </Button>
          )}
        </div>
        {runs.length > 0 && (
          <Table
            label={`Recent runs of ${routine.title}`}
            head={
              <>
                <th>State</th>
                <th>Started by</th>
                <th>When</th>
                <th className="num">Actions</th>
                <th>Result</th>
              </>
            }
          >
            {runs.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <Status {...stateTag(entry.status)} />
                </td>
                <td>{entry.trigger}</td>
                <td className="mono">
                  <time title={exact(entry.startedAt)}>{ago(entry.startedAt)}</time>
                </td>
                <td className="num mono">{entry.actions}</td>
                <td className="max-w-90 truncate text-muted" title={entry.result ?? undefined}>
                  {entry.result}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </Section>
  );
}
