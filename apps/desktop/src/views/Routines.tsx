import type { LocalRun, MachineState, MadeLink, Overview, RoutineView } from "@grenier/core/api";
import type { RoutineMode } from "@grenier/core/routines";
import { Check, FolderOpen, Link, Pencil, Play, Plus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import {
  ago,
  Button,
  Card,
  Empty,
  Field,
  FormCard,
  Input,
  Loading,
  Notice,
  Page,
  Secret,
  Select,
  Textarea,
  useAction,
  useLoad,
} from "../ui.tsx";
import { Requests } from "./Requests.tsx";

const MODES: RoutineMode[] = ["read-only", "shadow", "limited", "on"];
const MODE_SAYS: Record<RoutineMode, string> = {
  "read-only": "reads only",
  shadow: "says what it would do",
  limited: "acts, a set number of times a day",
  on: "acts, auto mode judging each step",
};

const load = () => api<{ routines: RoutineView[] }>("/routines").then((answer) => answer.routines);
const loadRuns = () => api<{ runs: LocalRun[] }>("/runs").then((answer) => answer.runs);
/** In an object, so a machine in no team (`team: null`) is told apart from one still loading. */
const loadTeam = () => api<Overview>("/overview").then((overview) => ({ team: overview.team }));
const loadWorkdir = () => api<MachineState>("/machine").then((machine) => machine.rules.workdir);

const WHEN: [string, string][] = [
  ["request", "When someone asks it"],
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
function RoutineForm({ routine, done, cancel }: { routine?: RoutineView; done: () => void; cancel: () => void }) {
  const [day, time] = routine?.trigger === "schedule" ? (routine.schedule ?? "").split(" ") : [];
  const [when, setWhen] = useState(routine?.trigger === "schedule" ? (day ?? "daily") : "request");
  const action = useAction(() => {});
  return (
    <FormCard
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void action
          .run("routine", async () => {
            await api(routine ? `/routines/${routine.id}` : "/routines", {
              method: routine ? "PUT" : "POST",
              body: {
                title: String(form.get("title") ?? ""),
                prompt: String(form.get("prompt") ?? ""),
                trigger: when === "request" ? "request" : "schedule",
                schedule: when === "hourly" ? "hourly" : `${when} ${String(form.get("time") ?? "05:00")}`,
                agent: String(form.get("agent") ?? "claude"),
                collector: form.get("collector") === "on",
              },
            });
            return undefined;
          })
          .then((ok) => ok && done());
      }}
    >
      <Notice message={action.message} />
      <Field>
        Name
        <Input name="title" placeholder="Update dependencies" defaultValue={routine?.title} required />
      </Field>
      <Field>
        What it does: its prompt to the agent
        <Textarea
          name="prompt"
          className="min-h-24"
          required
          defaultValue={routine?.prompt}
          placeholder="Bump the dependencies to their latest release, run the tests, and explain what changed."
        />
      </Field>
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field>
          When
          <Select value={when} onChange={(event) => setWhen(event.currentTarget.value)}>
            {WHEN.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        {when !== "request" && when !== "hourly" && (
          <Field>
            At, in UTC
            <Input name="time" type="time" defaultValue={time ?? "05:00"} required />
          </Field>
        )}
        <Field>
          Agent
          <Select name="agent" defaultValue={routine?.agent ?? "claude"}>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </Select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="collector" className="accent-accent" defaultChecked={routine?.collector} />
        Each person's own: it runs on their machines and writes to their Me
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={action.busy !== null}>
          {routine ? "Save" : "Add the routine"}
        </Button>
        <Button quiet onClick={cancel}>
          Cancel
        </Button>
      </div>
    </FormCard>
  );
}

/** The address another tool calls to ask a routine for work. */
function Webhook({ routine }: { routine: RoutineView }) {
  const [address, setAddress] = useState<string | null>(null);
  const team = useLoad(loadTeam);
  const action = useAction(() => {});
  if (!team.data?.team || routine.trigger !== "request") return null;
  return (
    <>
      <Button
        icon={Link}
        quiet
        disabled={action.busy !== null}
        onClick={() =>
          void action.run("webhook", async () => {
            const made = await api<MadeLink>("/team/webhooks", { body: { routine: routine.id } });
            setAddress(`${team.data?.team?.url ?? ""}${made.path}`);
            return undefined;
          })
        }
      >
        Webhook address
      </Button>
      <Notice message={action.message} />
      {address && (
        <Secret
          className="basis-full"
          value={address}
          copy="Copy address"
          note={`Another tool's webhook can call this address: each call files a request for ${routine.title}. Keep it secret.`}
        />
      )}
    </>
  );
}

export function Routines({ go, member }: ViewProps) {
  const routines = useLoad(load);
  const runs = useLoad(loadRuns);
  const team = useLoad(loadTeam);
  const workdir = useLoad(loadWorkdir);
  // Routines run on the team's machines: without a team there is nowhere to add one.
  const adding = !member && Boolean(team.data?.team);
  const [modes, setModes] = useState<Record<string, RoutineMode>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const action = useAction(() => {
    routines.reload();
    runs.reload();
  });
  const going = runs.data?.some((run) => run.status === "running") ?? false;
  useEffect(() => {
    if (!going) return;
    const timer = window.setInterval(runs.reload, 3000);
    return () => window.clearInterval(timer);
  }, [going, runs.reload]);

  const call = (key: string, path: string, body: unknown, done: string, method = "POST") =>
    void action.run(key, async () => {
      await api(path, { method, body });
      return { text: done };
    });
  const saved = () => {
    setEditing(null);
    routines.reload();
  };

  return (
    <Page
      title="Routines"
      intro="Tasks the team's machines run, each from its text. This machine runs one only once you approve it as it is, and only as far as its mode lets it: read-only first."
    >
      <Notice message={routines.error ?? action.message} />
      {workdir.data === "" && (
        <Card tone="accent" className="mb-5">
          <p>Routines run in this machine's work folder, the one that holds your projects. Set it first.</p>
          <Button className="mt-3" icon={FolderOpen} onClick={() => go("settings")}>
            Set the work folder
          </Button>
        </Card>
      )}
      {!routines.data && !routines.error && <Loading what="routines" />}
      {adding && routines.data && editing === "new" && <RoutineForm done={saved} cancel={() => setEditing(null)} />}
      {adding && routines.data && editing !== "new" && (
        <div className="mb-5 flex gap-2">
          <Button quiet icon={Plus} onClick={() => setEditing("new")}>
            New routine
          </Button>
          {!routines.data.some((routine) => routine.title === "Librarian") && (
            <Button
              icon={Plus}
              quiet
              disabled={action.busy !== null}
              title="A built-in routine that looks through the store each day and suggests fixes"
              onClick={() =>
                call("librarian", "/routines/librarian", {}, "Added the librarian: it runs each day at 05:00 UTC.")
              }
            >
              Add the librarian
            </Button>
          )}
        </div>
      )}
      {routines.data?.length === 0 && (
        <Empty>
          {(member || team.data?.team) && (
            <p>{member ? "The team has no routine yet." : "No routine yet: start with New routine."}</p>
          )}
          {!member && team.data && !team.data.team && (
            <>
              <p>
                Routines run through a team's store, which hands their work to its machines. A team can be just you:
                create one in your own Cloudflare account, and this machine runs your routines.
              </p>
              <Button className="mt-3" icon={Users} onClick={() => go("team")}>
                Create a team
              </Button>
            </>
          )}
        </Empty>
      )}
      {routines.data?.map((routine) => {
        if (editing === routine.id) {
          return <RoutineForm key={routine.id} routine={routine} done={saved} cancel={() => setEditing(null)} />;
        }
        const mode = modes[routine.id] ?? routine.approval?.mode ?? "read-only";
        const mine = (runs.data ?? []).filter((run) => run.routineId === routine.id).slice(0, 5);
        return (
          <Card key={routine.id}>
            <header className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{routine.title}</h2>
                <p className="mt-0.5 text-sm text-muted">
                  {routine.trigger === "schedule" ? `on a schedule, ${routine.schedule}` : `on ${routine.trigger}`} ·{" "}
                  {routine.agent} · by {routine.author}
                  {routine.collector && " · collector: runs on its person's machines, writes to their me"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Select
                  aria-label={`Mode of ${routine.title}`}
                  value={mode}
                  onChange={(event) => setModes({ ...modes, [routine.id]: event.currentTarget.value as RoutineMode })}
                >
                  {MODES.map((name) => (
                    <option key={name} value={name}>
                      {name}: {MODE_SAYS[name]}
                    </option>
                  ))}
                </Select>
                <Button
                  icon={Check}
                  disabled={action.busy !== null || !routine.prompt.trim()}
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

            <p className="mt-3 line-clamp-4 text-sm whitespace-pre-wrap" title={routine.prompt}>
              {routine.prompt.trim() || (
                <span className="text-muted">No text yet: it runs nowhere until an admin writes what it does.</span>
              )}
            </p>
            {routine.approval && !routine.approval.current && (
              <p className="mt-1.5 text-sm text-muted">
                Changed since you approved it: it runs here again once you approve the change.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                icon={Play}
                quiet
                disabled={action.busy !== null || going || !routine.prompt.trim() || !routine.approval?.current}
                title={routine.approval?.current ? undefined : "Approve it as it is now to run it here"}
                onClick={() =>
                  call(`run:${routine.id}`, `/routines/${routine.id}/run`, {}, `Running ${routine.title} here.`)
                }
              >
                Run now
              </Button>
              {!member && (
                <Button quiet icon={Pencil} onClick={() => setEditing(routine.id)}>
                  Edit
                </Button>
              )}
              {!member && <Webhook routine={routine} />}
            </div>

            {mine.length > 0 && (
              <ul className="mt-3 border-t border-line pt-2">
                {mine.map((run) => (
                  <li key={run.id} className="py-1.5">
                    <p className="text-sm">
                      <b className="font-semibold">{run.status}</b> · {run.trigger} · {ago(run.startedAt)}
                      {run.actions > 0 ? ` · ${run.actions} actions` : ""}
                    </p>
                    {run.result && (
                      <p className="mt-0.5 line-clamp-3 text-sm whitespace-pre-wrap text-muted">{run.result}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
      <Requests go={go} member={member} />
    </Page>
  );
}
