import type { BuiltinView, LocalRun, MachineState, RoutineView } from "@grenier/core/api";
import { ArrowRight, Play, Plus, Repeat } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { ListDetail } from "../shell/regions.tsx";
import { Button, IconButton, Primary } from "../ui/button.tsx";
import { Checkbox } from "../ui/choice.tsx";
import { Dialog, useConfirm } from "../ui/dialog.tsx";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { Field, Input, Select, Textarea } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Notice, Problem } from "../ui/notice.tsx";
import { Tag } from "../ui/tag.tsx";
import { Tree, type TreeNode, useFolding } from "../ui/tree.tsx";
import { useListSearch } from "./list-search.tsx";
import { usePolling } from "./polling.ts";
import { approvalTag, BuiltinDetail, RoutineDetail } from "./RoutineDetail.tsx";

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

const loadBuiltins = () => api<{ builtins: BuiltinView[] }>("/routines/builtins").then((answer) => answer.builtins);

/** The team's routines beside the one that is open: the built-in ones, the team's, and each person's own. */
export function Routines({ item, go, member, team, admin: adding }: ViewProps) {
  const routines = useLoad(load);
  const builtins = useLoad(loadBuiltins);
  const runs = useLoad(loadRuns);
  const workdir = useLoad(loadWorkdir);
  // Routines run on the team's machines: without a team there is nowhere to add one.
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

  const { field: searchField, query } = useListSearch("routines.search", "Search the routines", "Search routines");
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

  const all = (routines.data ?? []).filter(
    (routine) => !query || routine.title.toLowerCase().includes(query) || routine.prompt.toLowerCase().includes(query),
  );
  const leaf = (routine: RoutineView): TreeNode => ({
    id: `routine:${routine.id}`,
    name: routine.title,
    icon: Repeat,
    meta: approvalTag(routine),
  });
  const shipped = (builtins.data ?? []).filter((builtin) => !query || builtin.title.toLowerCase().includes(query));
  const nodes: TreeNode[] = [
    {
      id: "builtin/",
      name: "Built in",
      group: true,
      children: shipped.map((builtin) => {
        const added = (routines.data ?? []).find((routine) => routine.builtin === builtin.id);
        return added
          ? leaf(added)
          : { id: `builtin:${builtin.id}`, name: builtin.title, icon: Repeat, meta: <Tag>not added</Tag> };
      }),
    },
    {
      id: "team/",
      name: "Team",
      group: true,
      ...(adding
        ? { actions: <IconButton label="New routine" icon={Plus} size="sm" onClick={() => go("routines", "new")} /> }
        : {}),
      children: all.filter((routine) => !routine.builtin && !routine.collector).map(leaf),
    },
    {
      id: "own/",
      name: "Each person's own",
      group: true,
      children: all.filter((routine) => !routine.builtin && routine.collector).map(leaf),
    },
  ];

  const list = (
    <>
      {searchField}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Problem error={routines.error ?? builtins.error} />
        {routines.error ? null : !routines.data || !builtins.data ? (
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
  const builtin = item?.startsWith("builtin:")
    ? builtins.data?.find((entry) => `builtin:${entry.id}` === item)
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
      member={member}
      team={Boolean(team)}
      problem={action.problem}
      notice={settingUp}
      approve={(mode) =>
        call(
          `approve:${routine.id}`,
          `/routines/${routine.id}/approve`,
          { mode },
          `Approved ${routine.title} here, ${mode}`,
        )
      }
      stop={() =>
        void action.run(`stop:${routine.id}`, async () => {
          const was = routine.approval?.mode ?? "read-only";
          await api(`/routines/${routine.id}/approve`, { method: "DELETE" });
          return {
            text: `${routine.title} no longer runs here`,
            undo: () =>
              call(
                `approve:${routine.id}`,
                `/routines/${routine.id}/approve`,
                { mode: was },
                `Approved ${routine.title} here again`,
              ),
          };
        })
      }
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
      run={() =>
        call(`run:${routine.id}`, `/routines/${routine.id}/run`, {}, `Running ${routine.title} here`, "Starting")
      }
      edit={() => setEditing(routine.id)}
    />
  ) : builtin ? (
    <BuiltinDetail
      builtin={builtin}
      adding={adding}
      member={member}
      busy={action.busy !== null}
      problem={action.problem}
      add={() =>
        void action.run("add", async () => {
          const done = await api<{ id: string }>(`/routines/builtin/${builtin.id}`, { method: "POST" });
          select(`routine:${done.id}`);
          return `Added ${builtin.title}: approve it to run it here`;
        })
      }
      createTeam={() => go("team")}
    />
  ) : routines.data && team === null && !member ? (
    <Empty
      boot="no team yet"
      action={
        <Primary trailing={ArrowRight} onClick={() => go("team")}>
          Create a team
        </Primary>
      }
    >
      Routines run through a team's store, which hands their work to its machines. A team can be just you, in your own
      Cloudflare account.
    </Empty>
  ) : (
    <Empty boot="pick a routine">
      {member
        ? "Approve a routine to let this machine run it."
        : "Add a built-in one, or write your own with New routine."}
    </Empty>
  );

  return (
    <ListDetail title="Routines" list={list}>
      {detail}
      {dialog}
      {(item === "new" && adding) || editing ? (
        <RoutineForm
          {...(editing ? { routine: routines.data?.find((entry) => entry.id === editing) } : {})}
          done={saved}
          cancel={closeForm}
        />
      ) : null}
    </ListDetail>
  );
}
