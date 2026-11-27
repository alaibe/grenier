import type { LocalRun, MachineState, RoutineView } from "@grenier/core/api";
import type { RoutineMode } from "@grenier/core/routines";
import { ROUTINE_TEMPLATES, type RoutineTemplate } from "@grenier/core/templates";
import { ArrowRight, CirclePlay, Pause, Play, Plus, Repeat } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { ListDetail } from "../shell/regions.tsx";
import { Button, IconButton, Primary } from "../ui/button.tsx";
import { Dialog, useConfirm } from "../ui/dialog.tsx";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { Field, Input, Select, Textarea } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Notice, Problem } from "../ui/notice.tsx";
import { Tree, type TreeNode, useFolding } from "../ui/tree.tsx";
import { useListSearch } from "./list-search.tsx";
import { usePolling } from "./polling.ts";
import { MODE_SAYS, RoutineDetail, routineTag } from "./RoutineDetail.tsx";

const load = () => api<{ routines: RoutineView[] }>("/routines").then((answer) => answer.routines);
const loadRuns = () => api<{ runs: LocalRun[] }>("/runs").then((answer) => answer.runs);
const loadWorkdir = () => api<MachineState>("/machine").then((machine) => machine.rules.workdir);

const MODES: RoutineMode[] = ["read-only", "shadow", "limited", "on"];

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

/** What the form starts from: the routine being changed, a template, or nothing. */
type Start = Partial<Pick<RoutineView, "title" | "prompt" | "schedule" | "agent" | "mode" | "limit">>;

/** A routine's name, text, schedule, agent and mode: a new one, from a template if picked, or one changed in place. */
function RoutineForm({
  routine,
  done,
  cancel,
}: {
  routine?: RoutineView | undefined;
  done: () => void;
  cancel: () => void;
}) {
  const [template, setTemplate] = useState<RoutineTemplate | null>(null);
  const start: Start = routine ?? template ?? {};
  const [day, time] = start.schedule ? start.schedule.split(" ") : [];
  const [when, setWhen] = useState(start.schedule ? (day ?? "daily") : "hand");
  const [mode, setMode] = useState<RoutineMode>(start.mode ?? "read-only");
  const action = useAction(done);
  const pick = (id: string) => {
    const next = ROUTINE_TEMPLATES.find((entry) => entry.id === id) ?? null;
    setTemplate(next);
    setWhen(next?.schedule.split(" ")[0] ?? "hand");
    setMode(next?.mode ?? "read-only");
  };
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
              mode,
              ...(mode === "limited" ? { limit: String(form.get("limit") ?? "") } : {}),
            },
          });
          return routine ? `Saved ${String(form.get("title"))}` : `Added ${String(form.get("title"))}`;
        })
      }
    >
      <Problem error={action.problem} />
      {!routine && (
        <Field label="Start from" help="A template fills the form in: what you add is a routine of your own.">
          <Select value={template?.id ?? ""} onChange={(event) => pick(event.currentTarget.value)}>
            <option value="">Nothing</option>
            {ROUTINE_TEMPLATES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div key={template?.id ?? "none"} className="grid gap-4">
        <Field label="Name">
          <Input name="title" placeholder="Update dependencies" defaultValue={start.title} required />
        </Field>
        <Field label="Prompt" help="What the agent is asked to do, each time it runs.">
          <Textarea
            name="prompt"
            rows={5}
            required
            defaultValue={start.prompt}
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
            <Select name="agent" defaultValue={start.agent ?? "claude"}>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </Select>
          </Field>
          <Field label="Mode" help="What a run may do, on every machine.">
            <Select value={mode} onChange={(event) => setMode(event.currentTarget.value as RoutineMode)}>
              {MODES.map((name) => (
                <option key={name} value={name}>
                  {name}: {MODE_SAYS[name]}
                </option>
              ))}
            </Select>
          </Field>
          {mode === "limited" && (
            <Field label="Actions a day" help="On each machine, counted across its runs.">
              <Input name="limit" type="number" min={1} mono defaultValue={String(start.limit ?? 10)} required />
            </Field>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** The team's routines beside the one that is open; without a team there are none. */
export function Routines(props: ViewProps) {
  if (props.team === null) {
    return (
      <ListDetail title="Routines" list={null}>
        <Empty
          boot="no team yet"
          action={
            <Primary trailing={ArrowRight} onClick={() => props.go("team")}>
              Join or start a team
            </Primary>
          }
        >
          Routines run on a team's machines, which its store hands their work to. Join a team, or start one: it can be
          just you, in your own Cloudflare account.
        </Empty>
      </ListDetail>
    );
  }
  if (props.team === undefined) {
    return (
      <ListDetail title="Routines" list={<Skeleton rows={8} />}>
        {null}
      </ListDetail>
    );
  }
  return <TeamRoutines {...props} />;
}

function TeamRoutines({ item, go, admin }: ViewProps) {
  const routines = useLoad(load);
  const runs = useLoad(loadRuns);
  const workdir = useLoad(loadWorkdir);
  const [editing, setEditing] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();
  const [open, setOpen] = useFolding();
  const action = useAction(() => {
    routines.reload();
    runs.reload();
  });
  const going = runs.data?.some((run) => run.status === "running") ?? false;
  usePolling(runs.reload, going ? 3000 : null);
  const select = useCallback((id: string) => go("routines", id), [go]);

  const call = (key: string, path: string, done: string, working?: string) =>
    void action.run(
      key,
      async () => {
        await api(path, { body: {} });
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
  const runIt = (routine: RoutineView) =>
    call(`run:${routine.id}`, `/routines/${routine.id}/run`, `Running ${routine.title} here`, "Starting");
  const setRunning = (routine: RoutineView, running: boolean) =>
    void action.run(`state:${routine.id}`, async () => {
      await api(`/routines/${routine.id}/${running ? "resume" : "pause"}`, { body: {} });
      return {
        text: running ? `${routine.title} is running` : `Paused ${routine.title}`,
        undo: () => setRunning(routine, !running),
      };
    });

  const { field: searchField, query } = useListSearch("routines.search", "Search the routines", "Search routines");
  // biome-ignore lint/correctness/useExhaustiveDependencies: call reads the action as it is when it runs
  const commands = useMemo<Command[]>(
    () => [
      ...(admin
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
      ...(routines.data ?? []).flatMap((routine) => [
        ...(routine.state === "running" && routine.prompt.trim()
          ? [{ id: `run:${routine.id}`, label: `Run ${routine.title}`, icon: Play, run: () => runIt(routine) }]
          : []),
        ...(admin
          ? [
              routine.state === "running"
                ? {
                    id: `pause:${routine.id}`,
                    label: `Pause ${routine.title}`,
                    icon: Pause,
                    run: () => setRunning(routine, false),
                  }
                : {
                    id: `resume:${routine.id}`,
                    label: `Resume ${routine.title}`,
                    icon: CirclePlay,
                    run: () => setRunning(routine, true),
                  },
            ]
          : []),
      ]),
    ],
    [admin, routines.data, go],
  );
  useCommands(commands);

  const all = (routines.data ?? []).filter(
    (routine) => !query || routine.title.toLowerCase().includes(query) || routine.prompt.toLowerCase().includes(query),
  );
  const nodes: TreeNode[] = [
    {
      id: "team/",
      name: "Team",
      group: true,
      ...(admin
        ? { actions: <IconButton label="New routine" icon={Plus} size="sm" onClick={() => go("routines", "new")} /> }
        : {}),
      children: all.map((routine) => ({
        id: `routine:${routine.id}`,
        name: routine.title,
        icon: Repeat,
        meta: routineTag(routine),
      })),
    },
  ];

  const list = (
    <>
      {searchField}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Problem error={routines.error} />
        {routines.error ? null : !routines.data ? (
          <Skeleton rows={8} />
        ) : (
          <Tree
            label="Routines"
            nodes={nodes}
            selected={item ?? null}
            open={query ? () => true : open}
            onSelect={(node) => node.children === undefined && select(node.id)}
            onToggle={setOpen}
            onOpen={(node) => select(node.id)}
          />
        )}
      </div>
    </>
  );

  const routine = item?.startsWith("routine:")
    ? routines.data?.find((entry) => `routine:${entry.id}` === item)
    : undefined;
  const settingUp = workdir.data === "" && (
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
  );
  const detail = routine ? (
    <RoutineDetail
      key={routine.id}
      routine={routine}
      runs={(runs.data ?? []).filter((run) => run.routineId === routine.id).slice(0, 10)}
      busy={action.busy !== null}
      going={going}
      admin={admin}
      problem={action.problem}
      notice={settingUp}
      pause={() => setRunning(routine, false)}
      resume={() => setRunning(routine, true)}
      remove={() =>
        ask({
          title: `Remove ${routine.title} from the team?`,
          body: "No machine runs it again, and it leaves every teammate's list. Its runs and history stay.",
          action: "Remove from the team",
          run: () =>
            void action.run(`remove:${routine.id}`, async () => {
              await api(`/records/${encodeURIComponent(routine.id)}`, { method: "DELETE" });
              go("routines");
              return `Removed ${routine.title} from the team`;
            }),
        })
      }
      run={() => runIt(routine)}
      edit={() => setEditing(routine.id)}
    />
  ) : (
    <Empty boot="pick a routine">
      {admin
        ? "Pick one to run, pause or change it, or add one with New routine, from a template or your own."
        : "Pick one to see what it does and run it here. An admin adds and changes them."}
    </Empty>
  );

  return (
    <ListDetail title="Routines" list={list}>
      {detail}
      {dialog}
      {(item === "new" && admin) || editing ? (
        <RoutineForm
          {...(editing ? { routine: routines.data?.find((entry) => entry.id === editing) } : {})}
          done={saved}
          cancel={closeForm}
        />
      ) : null}
    </ListDetail>
  );
}
