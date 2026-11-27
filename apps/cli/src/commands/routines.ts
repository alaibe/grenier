import { ROUTINE_MODES } from "@grenier/core";
import type { LocalRun, RoutineView } from "@grenier/core/api";
import { ROUTINE_TEMPLATES, type RoutineTemplate } from "@grenier/core/templates";
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

const how = (routine: RoutineView) => (routine.mode === "limited" ? `limited, ${routine.limit} a day` : routine.mode);

const FORM = {
  prompt: { type: "string" },
  schedule: { type: "string" },
  agent: { type: "string" },
  mode: { type: "string" },
  limit: { type: "string" },
} as const;

/** The form a routine is written with: when, by which agent, and what a run may do; else as it was, or its template. */
function form(flags: Record<string, unknown>, before?: RoutineView | RoutineTemplate) {
  if (flags.agent !== undefined && !AGENTS.some((agent) => agent.agent === flags.agent)) {
    throw new UsageError(`--agent is ${AGENTS.map((agent) => agent.agent).join(" or ")}`);
  }
  if (flags.mode !== undefined && !(ROUTINE_MODES as readonly unknown[]).includes(flags.mode)) {
    throw new UsageError(`--mode is one of ${ROUTINE_MODES.join(", ")}`);
  }
  const was = before && "limit" in before ? before : undefined;
  return {
    schedule: (flags.schedule as string | undefined) ?? before?.schedule ?? "",
    agent: (flags.agent as string | undefined) ?? was?.agent ?? "claude",
    mode: (flags.mode as string | undefined) ?? before?.mode ?? "read-only",
    ...(flags.limit !== undefined ? { limit: flags.limit } : was ? { limit: was.limit } : {}),
  };
}

export const ROUTINES: Group = {
  summary: "Routines: work the team's machines run for it, as its admins set it.",
  commands: {
    list: {
      usage: "list",
      summary: "List the team's routines: when, which agent, what a run may do, running or paused",
      call: ({ admin }) => routines(admin),
      show: (all: RoutineView[]) =>
        table(
          all.map((routine) => [
            routine.id,
            routine.title,
            routine.schedule ?? "by hand",
            routine.agent,
            how(routine),
            routine.state,
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
          `${routine.schedule ?? "by hand"} · ${routine.agent} · ${how(routine)} · ${routine.state}`,
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
    templates: {
      usage: "templates",
      summary: "List the templates a new routine can start from",
      call: async () => ROUTINE_TEMPLATES,
      show: (templates: readonly RoutineTemplate[]) =>
        table(templates.map((template) => [template.id, template.title, template.schedule, template.mode])),
    },
    new: {
      usage: `new [<name>] [--template <id>] [--prompt <file>|-] [--schedule <when>] [--agent claude|codex] [--mode ${ROUTINE_MODES.join("|")}] [--limit <actions>]`,
      summary: 'Write a routine for the team (admins), from a template if given; a schedule reads "mon 09:00"',
      options: { ...FORM, template: { type: "string" } },
      takes: [0, 1],
      call: ({ admin, args, flags, io }) => {
        const template = flags.template === undefined ? undefined : templateNamed(String(flags.template));
        const title = args[0] ?? template?.title;
        if (!title) throw new UsageError("new names the routine, or gives --template");
        const prompt =
          flags.prompt === undefined && template ? template.prompt : (edited(io, flags.prompt, "", "prompt") ?? "");
        return admin("POST", "/routines", { title, prompt, ...form(flags, template) });
      },
      show: (answer: { id: string }) => `Wrote ${answer.id}: it is running`,
    },
    edit: {
      usage: `edit <id|name> [--title <name>] [--prompt <file>|-] [--schedule <when>] [--agent claude|codex] [--mode ${ROUTINE_MODES.join("|")}] [--limit <actions>]`,
      summary: "Change a routine (admins): its text in $EDITOR when nothing else is given",
      options: { ...FORM, title: { type: "string" } },
      takes: [1, 1],
      call: async ({ admin, args, flags, io }) => {
        const routine = await routineNamed(admin, args[0] as string);
        const edit = editedUnless(io, flags, ["title", "schedule", "agent", "mode", "limit"], "prompt", routine.prompt);
        if (edit === null) return UNCHANGED;
        return admin("PUT", `/routines/${q(routine.id)}`, {
          title: flags.title ?? routine.title,
          prompt: edit ?? routine.prompt,
          ...form(flags, routine),
        });
      },
      show: (answer: { id: string }) => `Saved ${answer.id}`,
    },
    pause: onOne({
      usage: "pause <id|name>",
      summary: "Pause a routine (admins): no machine runs it until it is resumed",
      find: routineNamed,
      send: (admin, routine) => admin("POST", `/routines/${q(routine.id)}/pause`),
      done: (routine) => `Paused ${routine.title}`,
    }),
    resume: onOne({
      usage: "resume <id|name>",
      summary: "Set a paused routine running again (admins)",
      find: routineNamed,
      send: (admin, routine) => admin("POST", `/routines/${q(routine.id)}/resume`),
      done: (routine) => `${routine.title} is running`,
    }),
    run: {
      usage: "run <id|name> [<task…>]",
      summary: "Run a running routine here now, with a task of its own if given",
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

function templateNamed(wanted: string): RoutineTemplate {
  const found = ROUTINE_TEMPLATES.find((template) => template.id === wanted);
  if (!found) throw new UsageError(`--template is ${ROUTINE_TEMPLATES.map((template) => template.id).join(" or ")}`);
  return found;
}
