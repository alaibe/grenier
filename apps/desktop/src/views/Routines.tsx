import type { BuiltinView, LocalRun, MachineState, RoutineView } from "@grenier/core/api";
import type { RoutineMode } from "@grenier/core/routines";
import { ArrowRight, Check, CircleStop, Pencil, Play, Plus, Repeat, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { MarkdownEditor } from "../editor/markdown-editor.tsx";
import { ago, exact } from "../format.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { DetailBar, ListDetail, useItemTitle } from "../shell/regions.tsx";
import { stateTag } from "../states.ts";
import { Button, IconButton, Primary } from "../ui/button.tsx";
import { Checkbox } from "../ui/choice.tsx";
import { Dialog, useConfirm } from "../ui/dialog.tsx";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { Field, Input, SearchField, Select, Textarea } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Menu } from "../ui/menu.tsx";
import { Notice, Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { Table } from "../ui/table.tsx";
import { Status, Tag } from "../ui/tag.tsx";
import { Tree, type TreeNode, toTree, useFolding } from "../ui/tree.tsx";
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

const loadBuiltins = () => api<{ builtins: BuiltinView[] }>("/routines/builtins").then((answer) => answer.builtins);

/** Where a routine stands on this machine, for its row: approved as it is, changed since, or not approved. */
function approvalTag(routine: RoutineView) {
  return <Status {...stateTag(routine.approval?.current ? "approved" : routine.approval ? "changed" : "not-here")} />;
}

/** The team's routines beside the one that is open: the built-in ones, the team's, and each person's own. */
export function Routines({ item, go, member, team }: ViewProps) {
  const routines = useLoad(load);
  const builtins = useLoad(loadBuiltins);
  const runs = useLoad(loadRuns);
  const workdir = useLoad(loadWorkdir);
  // Routines run on the team's machines: without a team there is nowhere to add one.
  const adding = !member && Boolean(team);
  const [editing, setEditing] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();
  const [open, setOpen] = useFolding();
  const [words, setWords] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const query = words.trim().toLowerCase();
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
      {
        id: "routines.search",
        label: "Search the routines",
        keys: "/",
        also: ["mod+f"],
        hint: { in: "list", says: "search", order: 30 },
        run: () => search.current?.focus(),
      },
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
      <div className="border-b border-line p-3">
        <SearchField
          ref={search}
          label="Search the routines"
          placeholder="Search routines"
          live
          value={words}
          onChange={(event) => setWords(event.currentTarget.value)}
          onKeyDown={toTree}
        />
      </div>
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

/** A routine Grenier ships, not added yet: what it does, and Add. */
function BuiltinDetail({
  builtin,
  adding,
  member,
  busy,
  problem,
  add,
  createTeam,
}: {
  builtin: BuiltinView;
  adding: boolean;
  member: boolean;
  busy: boolean;
  problem: string | null;
  add: () => void;
  createTeam: () => void;
}) {
  return (
    <article className="flex h-full min-w-0 flex-col overflow-y-auto">
      <DetailBar crumb={<>Built in / {builtin.title}</>}>
        {adding && (
          <Primary size="sm" icon={Plus} busy={busy} onClick={add}>
            Add it
          </Primary>
        )}
      </DetailBar>
      <div className="mx-auto grid w-full max-w-(--layout-reading) gap-4 px-6 pt-10 pb-24">
        <div>
          <h1 className="font-mono text-xl leading-tight font-semibold tracking-tight">{builtin.title}</h1>
          <p className="mt-2 font-mono text-xs text-muted">
            {builtin.schedule} UTC · {builtin.local ? "no agent, no cost" : "an agent"} ·{" "}
            {builtin.collector ? "each person's own, written to their Me" : "for the team"}
          </p>
        </div>
        <Problem error={problem} />
        {member && <Notice kind="info">An admin adds it for the team.</Notice>}
        {!adding && !member && (
          <Notice
            kind="info"
            action={
              <Button size="sm" trailing={ArrowRight} onClick={createTeam}>
                Create a team
              </Button>
            }
          >
            Routines run through a team's store: adding one needs a team, which can be just you.
          </Notice>
        )}
        <MarkdownEditor value={builtin.prompt} editable={false} label={`What ${builtin.title} does`} />
      </div>
    </article>
  );
}

/** One routine: its prompt, its mode and approval here, Run now, and its runs here and on the team. */
function RoutineDetail({
  routine,
  runs,
  busy,
  going,
  member,
  team,
  problem,
  notice,
  approve,
  stop,
  remove,
  run,
  edit,
}: {
  routine: RoutineView;
  runs: LocalRun[];
  busy: boolean;
  going: boolean;
  member: boolean;
  team: boolean;
  problem: string | null;
  notice: ReactNode;
  approve: (mode: RoutineMode) => void;
  stop: () => void;
  remove: () => void;
  run: () => void;
  edit: () => void;
}) {
  const [mode, setMode] = useState<RoutineMode>(routine.approval?.mode ?? "read-only");
  useItemTitle(routine.title);
  // The bar approves; here only a change of mode of an approved routine needs one.
  const remode = routine.approval?.current && routine.approval.mode !== mode;
  const when = routine.schedule ? `${routine.schedule} UTC` : "run by hand";
  const group = routine.builtin ? "Built in" : routine.collector ? "Each person's own" : "Team";
  return (
    <article className="flex h-full min-w-0 flex-col overflow-y-auto">
      <DetailBar
        crumb={
          <>
            {group} / {routine.title}
          </>
        }
      >
        {approvalTag(routine)}
        {!member && (
          <Button icon={Pencil} size="sm" onClick={edit}>
            Edit
          </Button>
        )}
        {(routine.approval || !member) && (
          <Menu
            label="More"
            items={[
              ...(routine.approval ? [{ label: "Stop running here", icon: CircleStop, run: stop }] : []),
              ...(member ? [] : [{ label: "Remove from the team", icon: Trash2, danger: true, run: remove }]),
            ]}
          />
        )}
        {routine.approval?.current ? (
          <Button
            icon={Play}
            size="sm"
            disabled={busy || going || !routine.prompt.trim()}
            title={going ? "A run is going on this machine" : undefined}
            onClick={run}
          >
            Run now
          </Button>
        ) : (
          <Button icon={Check} size="sm" disabled={busy || !routine.prompt.trim()} onClick={() => approve(mode)}>
            {routine.approval ? "Approve the change" : `Approve to run here, ${mode}`}
          </Button>
        )}
      </DetailBar>
      <div className="mx-auto grid w-full max-w-(--layout-reading) gap-6 px-6 pt-10 pb-24">
        <div>
          <h1 className="font-mono text-xl leading-tight font-semibold tracking-tight">{routine.title}</h1>
          <p className="mt-2 font-mono text-xs text-muted">
            {when} · {routine.agent} · by {routine.author}
            {routine.collector ? " · each person's own" : ""}
          </p>
        </div>
        {(problem || notice || (routine.approval && !routine.approval.current)) && (
          <div className="grid gap-2">
            <Problem error={problem} />
            {notice}
            {routine.approval && !routine.approval.current && (
              <Notice kind="warn">
                Changed since you approved it: it runs here again once you approve the change.
              </Notice>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-72">
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
          {remode && (
            <Button icon={Check} disabled={busy} onClick={() => approve(mode)}>
              Approve in this mode
            </Button>
          )}
        </div>
        {routine.prompt.trim() ? (
          <MarkdownEditor
            key={routine.prompt}
            value={routine.prompt}
            editable={false}
            label={`What ${routine.title} does`}
          />
        ) : (
          <p className="text-muted">No text yet: it runs nowhere until an admin writes what it does.</p>
        )}
        {runs.length > 0 && (
          <Section heading title="Runs here">
            <Table
              label={`Recent runs of ${routine.title} here`}
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
          </Section>
        )}
        {team && <TeamRuns routine={routine.id} />}
      </div>
    </article>
  );
}
