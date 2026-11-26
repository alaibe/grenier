import { ROUTINE_MODES } from "@grenier/core";
import type { BuiltinView, LocalRun, RoutineView } from "@grenier/core/api";
import { AGENTS } from "../agents/index.ts";
import { UsageError } from "../io.ts";
import {
  type Admin,
  edited,
  editedUnless,
  firstLine,
  type Group,
  onOne,
  pick,
  q,
  table,
  UNCHANGED,
  when,
} from "./client.ts";

const routines = async (admin: Admin) => (await admin<{ routines: RoutineView[] }>("GET", "/routines")).routines;

const routineNamed = async (admin: Admin, wanted: string) =>
  pick(await routines(admin), wanted, "routine", (routine) => routine.title);

const approval = (routine: RoutineView) =>
  !routine.approval
    ? "not approved"
    : routine.approval.current
      ? `approved, ${routine.approval.mode}`
      : "changed: approve it again";

const FORM = {
  prompt: { type: "string" },
  schedule: { type: "string" },
  agent: { type: "string" },
  collector: { type: "boolean" },
} as const;

/** The form a routine is written with: what it does, when, and by which agent. */
function form(flags: Record<string, unknown>, before?: RoutineView) {
  if (flags.agent !== undefined && !AGENTS.some((agent) => agent.agent === flags.agent)) {
    throw new UsageError(`--agent is ${AGENTS.map((agent) => agent.agent).join(" or ")}`);
  }
  return {
    schedule: (flags.schedule as string | undefined) ?? before?.schedule ?? "",
    agent: (flags.agent as string | undefined) ?? before?.agent ?? "claude",
    collector: (flags.collector as boolean | undefined) ?? before?.collector ?? false,
  };
}

export const ROUTINES: Group = {
  summary: "Routines: work the team's machines run for it, each approved here first.",
  commands: {
    list: {
      usage: "list",
      summary: "List the team's routines, and how this machine approved each",
      call: ({ admin }) => routines(admin),
      show: (all: RoutineView[]) =>
        table(
          all.map((routine) => [
            routine.id,
            routine.title,
            routine.schedule ?? "by hand",
            routine.agent,
            approval(routine),
          ]),
        ) || "no routines",
    },
    show: {
      usage: "show <id|name>",
      summary: "Print a routine: when it runs and what it does",
      takes: [1, 1],
      call: ({ admin, args }) => routineNamed(admin, args[0] as string),
      show: (routine: RoutineView) =>
        [
          `# ${routine.title}`,
          `${routine.schedule ?? "by hand"} · ${routine.agent} · ${approval(routine)}${routine.builtin ? ` · built in: ${routine.builtin}` : ""}`,
          "",
          routine.prompt,
        ].join("\n"),
    },
    runs: {
      usage: "runs [<id|name>] [--team]",
      summary: "List this machine's runs, or with --team a routine's runs on every machine",
      options: { team: { type: "boolean" } },
      takes: [0, 1],
      call: async ({ admin, args, flags }) => {
        const routine = args[0] ? await routineNamed(admin, args[0]) : null;
        if (flags.team) {
          if (!routine) throw new UsageError("runs --team names the routine");
          return (await admin<{ runs: LocalRun[] }>("GET", `/team/runs?routine=${q(routine.id)}`)).runs;
        }
        const runs = (await admin<{ runs: LocalRun[] }>("GET", "/runs")).runs;
        return routine ? runs.filter((run) => run.routineId === routine.id) : runs;
      },
      show: (runs: LocalRun[]) =>
        table(
          runs.map((run) => [
            when(run.startedAt),
            run.routineId,
            run.trigger,
            run.status,
            `${run.actions} actions`,
            firstLine(run.result),
          ]),
        ) || "no runs",
    },
    builtins: {
      usage: "builtins",
      summary: "List the routines Grenier ships",
      call: async ({ admin }) => (await admin<{ builtins: BuiltinView[] }>("GET", "/routines/builtins")).builtins,
      show: (builtins: BuiltinView[]) =>
        table(
          builtins.map((builtin) => [builtin.id, builtin.title, builtin.schedule, builtin.local ? "no agent" : ""]),
        ),
    },
    add: {
      usage: "add <builtin>",
      summary: "Add one of Grenier's routines to the team (admins)",
      takes: [1, 1],
      call: ({ admin, args }) => admin("POST", `/routines/builtin/${q(args[0] as string)}`),
      show: (answer: { id: string }) => `Added ${answer.id}: approve it on each machine that runs it`,
    },
    new: {
      usage: "new <name> [--prompt <file>|-] [--schedule <when>] [--agent claude|codex] [--collector]",
      summary: 'Write a routine for the team (admins); a schedule reads "daily 05:00" or "mon 09:00"',
      options: FORM,
      takes: [1, 1],
      call: ({ admin, args, flags, io }) =>
        admin("POST", "/routines", {
          title: args[0],
          prompt: edited(io, flags.prompt, "", "prompt") ?? "",
          ...form(flags),
        }),
      show: (answer: { id: string }) => `Wrote ${answer.id}: approve it on each machine that runs it`,
    },
    edit: {
      usage:
        "edit <id|name> [--title <name>] [--prompt <file>|-] [--schedule <when>] [--agent claude|codex] [--collector]",
      summary: "Change a routine (admins): its text in $EDITOR when nothing else is given",
      options: { ...FORM, title: { type: "string" } },
      takes: [1, 1],
      call: async ({ admin, args, flags, io }) => {
        const routine = await routineNamed(admin, args[0] as string);
        const edit = editedUnless(io, flags, ["title", "schedule", "agent", "collector"], "prompt", routine.prompt);
        if (edit === null) return UNCHANGED;
        const prompt = edit ?? routine.prompt;
        return admin("PUT", `/routines/${q(routine.id)}`, {
          title: flags.title ?? routine.title,
          prompt,
          ...form(flags, routine),
        });
      },
      show: (answer: { id: string }) => `Saved ${answer.id}: each machine approves it again`,
    },
    approve: {
      usage: `approve <id|name> [--mode ${ROUTINE_MODES.join("|")}] [--limit <actions>]`,
      summary: "Let this machine run a routine, read-only unless --mode allows more",
      options: { mode: { type: "string" }, limit: { type: "string" } },
      takes: [1, 1],
      call: async ({ admin, args, flags }) => {
        const mode = (flags.mode as string | undefined) ?? "read-only";
        if (!(ROUTINE_MODES as readonly string[]).includes(mode)) {
          throw new UsageError(`--mode is one of ${ROUTINE_MODES.join(", ")}`);
        }
        const routine = await routineNamed(admin, args[0] as string);
        await admin("POST", `/routines/${q(routine.id)}/approve`, {
          mode,
          ...(flags.limit ? { limit: Number(flags.limit) } : {}),
        });
        return { approved: routine.title, mode };
      },
      show: (answer: { approved: string; mode: string }) => `Approved ${answer.approved}, ${answer.mode}`,
    },
    stop: onOne({
      usage: "stop <id|name>",
      summary: "Stop running a routine on this machine; the team keeps it",
      find: routineNamed,
      send: (admin, routine) => admin("DELETE", `/routines/${q(routine.id)}/approve`),
      done: (routine) => `This machine no longer runs ${routine.title}`,
    }),
    run: {
      usage: "run <id|name> [<task…>]",
      summary: "Run a routine here now, with a task of its own if given",
      takes: [1, 99],
      call: async ({ admin, args }) => {
        const [wanted, ...task] = args;
        const routine = await routineNamed(admin, wanted as string);
        await admin("POST", `/routines/${q(routine.id)}/run`, { task: task.join(" ") });
        return { started: routine.title };
      },
      show: (answer: { started: string }) => `Started ${answer.started}: grenier routine runs shows how it went`,
    },
    rm: onOne({
      usage: "rm <id|name>",
      summary: "Remove a routine from the team, for every machine (admins)",
      find: routineNamed,
      send: (admin, routine) => admin("DELETE", `/records/${q(routine.id)}`),
      done: (routine) => `Removed ${routine.title}`,
    }),
  },
};
