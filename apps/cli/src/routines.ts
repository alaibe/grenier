import { existsSync, readFileSync } from "node:fs";
import {
  type Config,
  ConfigError,
  hasPrompt,
  nextDue,
  parseConfig,
  ROUTINE_MODES,
  type RoutineMode,
  routineHash,
} from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { newId, type StoreDeps, type TeamClient, teamApi, write } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import type { Reply, Route } from "./host.ts";
import { CommandError, writeAtomically } from "./io.ts";
import { LIBRARIAN } from "./librarian.ts";
import type { Runner } from "./runner.ts";
import { withTomlValue } from "./team.ts";

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const no = (status: number, error: string): Reply => ({ status, body: { error } });

/** The rules a person sets for this machine, as config.toml's [machine] table takes them. */
const RULES = ["routines", "plugged_in", "idle_minutes", "cpu_max", "memory_max", "hours", "agent", "name"] as const;

/** Writes rules into config.toml, keeping everything else, once the whole file still reads as a valid config. */
export function setRules(paths: GrenierPaths, change: Record<string, unknown>): Config {
  let text = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  for (const [key, value] of Object.entries(change)) {
    if (!(RULES as readonly string[]).includes(key)) throw new CommandError(`[machine] has no ${key}`);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new CommandError(`${key} takes a value`);
    }
    text = withTomlValue(text, "machine", key, value);
  }
  let config: Config;
  try {
    config = parseConfig(text, paths.config);
  } catch (error) {
    throw new CommandError(error instanceof ConfigError ? error.message : String(error));
  }
  writeAtomically(paths.config, text.endsWith("\n") ? text : `${text}\n`);
  return config;
}

export interface RoutineView {
  id: string;
  title: string;
  top: string;
  author: string;
  trigger: string;
  schedule: string | null;
  repo: string | null;
  /** Whether the routine's repository is on this machine. */
  repoHere: boolean;
  agent: string;
  collector: boolean;
  tools: string[];
  /** What a run does: the routine's text. */
  prompt: string;
  /** How this machine's person approved it: its mode, and whether it changed since. */
  approval: { mode: RoutineMode; limit: number; current: boolean } | null;
}

export async function routineViews(store: Store): Promise<RoutineView[]> {
  const tops = (await store.tops.list()).map((top) => top.id);
  const out: RoutineView[] = [];
  for (const routine of await store.records.list({ tops, type: "Routine" })) {
    const approval = await store.approvals.get(routine.id, "routine");
    const repo = typeof routine.fields.repo === "string" && routine.fields.repo ? routine.fields.repo : null;
    out.push({
      id: routine.id,
      title: routine.title,
      top: routine.top,
      author: routine.author,
      trigger: String(routine.fields.trigger ?? "request"),
      schedule: typeof routine.fields.schedule === "string" ? routine.fields.schedule : null,
      repo,
      repoHere: repo ? Boolean((await store.tops.get(`repo:${repo}`))?.root) : true,
      agent: String(routine.fields.agent ?? "claude"),
      collector: routine.fields.collector === "yes",
      tools: Array.isArray(routine.fields.tools) ? routine.fields.tools.map(String) : [],
      prompt: routine.body,
      approval: approval
        ? {
            mode: (approval.settings.mode as RoutineMode) ?? "read-only",
            limit: Number(approval.settings.limit ?? 10),
            current: approval.hash === (await routineHash(routine)),
          }
        : null,
    });
  }
  return out;
}

/** Approves a routine as it is now, on this machine, in a mode. */
export async function approve(store: Store, routine: FullRecord, mode: RoutineMode, limit = 10): Promise<void> {
  if (!ROUTINE_MODES.includes(mode)) throw new CommandError(`a mode is one of ${ROUTINE_MODES.join(", ")}`);
  if (!hasPrompt(routine))
    throw new CommandError("the routine says nothing to do yet: an admin gives it its text first");
  const before = await store.approvals.get(routine.id, "routine");
  await store.approvals.put({
    recordId: routine.id,
    kind: "routine",
    hash: await routineHash(routine),
    approvedAt: Date.now(),
    settings: { mode, limit },
    installedPath: null,
    previousHash: before?.hash ?? null,
  });
}

/** Adds the built-in routine that looks through the store each day and suggests fixes, once. */
export async function addLibrarian(deps: StoreDeps): Promise<{ id: string; added: boolean }> {
  const tops = (await deps.store.tops.list()).map((top) => top.id);
  const existing = (await deps.store.records.list({ tops, type: "Routine" })).find(
    (record) => record.fields.builtin === LIBRARIAN,
  );
  if (existing) return { id: existing.id, added: false };
  const added = await addRoutine(deps, {
    title: "Librarian",
    prompt:
      "Built in: looks through the store for stale memories, duplicates, broken rules and orphaned requests, and suggests fixes.",
    fields: { trigger: "schedule", schedule: "daily 05:00", builtin: LIBRARIAN },
    repo: null,
    top: "team",
  });
  return { id: added.id, added: true };
}

/** A routine as the app's form gives it: what it does, when, with which tools and agent, in which repository. */
export function routineFromForm(input: Record<string, unknown>): {
  title: string;
  prompt: string;
  fields: Record<string, unknown>;
  repo: string | null;
} {
  const title = String(input.title ?? "").trim();
  const prompt = String(input.prompt ?? "").trim();
  if (!title || !prompt) throw new CommandError("a routine needs a name and what it does");
  const trigger = input.trigger === "schedule" ? "schedule" : "request";
  const schedule = String(input.schedule ?? "").trim();
  if (trigger === "schedule" && nextDue(schedule, Date.now()) === null) {
    throw new CommandError('a schedule reads "hourly", "daily 05:00", "weekdays 09:00" or "mon 09:00"');
  }
  const tools = (Array.isArray(input.tools) ? input.tools : String(input.tools ?? "").split(","))
    .map((tool) => String(tool).trim())
    .filter(Boolean);
  const repo = typeof input.repo === "string" && input.repo ? input.repo : null;
  return {
    title,
    prompt,
    repo,
    fields: {
      trigger,
      ...(trigger === "schedule" ? { schedule } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(input.agent === "codex" ? { agent: "codex" } : {}),
      ...(input.collector === true ? { collector: "yes" } : {}),
    },
  };
}

/** The fields a routine keeps, from the form: what the form leaves out goes, but a built-in stays built in. */
function routineFields(
  deps: StoreDeps,
  input: { fields: Record<string, unknown>; repo: string | null },
  before?: FullRecord,
): Record<string, unknown> {
  const owner = before?.fields.collector === "yes" ? before.fields.owner : deps.me.member;
  return {
    ...input.fields,
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.fields.collector === "yes" ? { owner } : {}),
    ...(before?.fields.builtin ? { builtin: before.fields.builtin } : {}),
  };
}

/** Writes a new routine; its text is what each run does. */
export async function addRoutine(
  deps: StoreDeps,
  input: {
    title: string;
    prompt: string;
    fields: Record<string, unknown>;
    repo: string | null;
    top: string;
    folder?: string;
  },
): Promise<{ id: string }> {
  const tops = (await deps.store.tops.list()).map((top) => top.id);
  const taken = (await deps.store.records.list({ tops, type: "Routine" })).some(
    (record) => record.title.toLowerCase() === input.title.toLowerCase(),
  );
  if (taken) throw new CommandError(`there is a routine named ${input.title} already: edit it`);
  const id = newId();
  const now = Date.now();
  await write(deps, {
    id,
    top: input.top,
    type: "Routine",
    kind: null,
    title: input.title,
    folder: input.folder ?? "",
    body: input.prompt,
    fields: routineFields(deps, input),
    author: deps.me.member,
    device: deps.me.device,
    sessionId: null,
    createdAt: now,
    updatedAt: now,
    retiredAt: null,
    version: 0,
    anchors: [],
    links: [],
  });
  return { id };
}

/** Changes a routine in place: a run going on keeps what it started with, and the next one takes the change. */
export async function editRoutine(
  deps: StoreDeps,
  routine: FullRecord,
  input: { title: string; prompt: string; fields: Record<string, unknown>; repo: string | null },
): Promise<void> {
  const { seq: _seq, hits: _hits, ...rest } = routine;
  await write(
    deps,
    {
      ...rest,
      title: input.title,
      body: input.prompt,
      fields: routineFields(deps, input, routine),
      updatedAt: Date.now(),
    },
    routine,
  );
}

/** The admin API's pages for this machine's rules and the team's routines on it. */
export function routineRoutes(deps: {
  store: Store;
  paths: GrenierPaths;
  runner: Runner;
  storeDeps: () => Promise<StoreDeps>;
  team: () => TeamClient | null;
  /** Called after the rules changed, so the daemon reads them again. */
  reloaded: (config: Config) => void;
  config: () => Config;
}): Route {
  const { store, runner } = deps;
  const started = (work: Promise<unknown>) => {
    work.catch(() => undefined);
    return ok({ started: true }, 202);
  };

  return async (method, path, body) => {
    const input = (body ?? {}) as Record<string, unknown>;
    if (path === "/machine" && method === "GET") {
      const config = deps.config();
      return ok({ rules: config.machine, running: runner.running, ...(await runner.state()) });
    }
    if (path === "/machine" && method === "PUT") {
      try {
        const config = setRules(deps.paths, (input.rules ?? {}) as Record<string, unknown>);
        deps.reloaded(config);
        if (typeof (input.rules as Record<string, unknown>)?.name === "string" && deps.team()) {
          await teamApi(deps.team() as TeamClient, "/api/me/device", {
            method: "PUT",
            body: { name: (input.rules as Record<string, unknown>).name },
          }).catch(() => undefined);
        }
        void runner.tick(true);
        return ok({ rules: config.machine, ...(await runner.state()) });
      } catch (error) {
        return no(400, (error as Error).message);
      }
    }
    if (path === "/routines" && method === "GET") return ok({ routines: await routineViews(store) });
    if (path === "/runs" && method === "GET") return ok({ runs: await store.runs.list({ limit: 50 }) });

    const adding = method === "POST" && (path === "/routines" || path === "/routines/librarian");
    if (adding && !deps.team()) return no(409, "routines run on the team's machines: start or join a team first");
    if (path === "/routines" && method === "POST") {
      try {
        const routine = routineFromForm(input);
        const added = await addRoutine(await deps.storeDeps(), { ...routine, top: "team" });
        return ok(added);
      } catch (error) {
        return no(409, (error as Error).message);
      }
    }
    if (path === "/routines/librarian" && method === "POST") {
      try {
        return ok(await addLibrarian(await deps.storeDeps()));
      } catch (error) {
        return no(409, (error as Error).message);
      }
    }
    const edit = /^\/routines\/([^/]+)$/.exec(path);
    if (edit && method === "PUT") {
      const routine = await store.records.get(decodeURIComponent(edit[1] as string));
      if (routine?.type !== "Routine" || routine.retiredAt !== null) return no(404, "no such routine");
      try {
        await editRoutine(await deps.storeDeps(), routine, routineFromForm(input));
        return ok({ id: routine.id });
      } catch (error) {
        return no(409, (error as Error).message);
      }
    }

    const match = /^\/routines\/([^/]+)\/(approve|run)$/.exec(path);
    if (!match) return null;
    const routine = await store.records.get(decodeURIComponent(match[1] as string));
    if (routine?.type !== "Routine" || routine.retiredAt !== null) return no(404, "no such routine");
    try {
      switch (`${method} ${match[2]}`) {
        case "POST approve":
          await approve(store, routine, (input.mode as RoutineMode) ?? "read-only", Number(input.limit ?? 10));
          void runner.tick(true);
          return ok({ approved: routine.id });
        case "POST run": {
          const approval = await store.approvals.get(routine.id, "routine");
          if (!approval || approval.hash !== (await routineHash(routine))) {
            return no(409, "approve the routine as it is now before running it");
          }
          if (!hasPrompt(routine)) return no(409, "the routine says nothing to do yet");
          if (runner.running) return no(409, "a run is going on this machine already");
          const prompt =
            typeof input.task === "string" && input.task.trim() ? input.task.trim() : "Run now, as your prompt says.";
          const mode = (approval.settings.mode as RoutineMode) ?? "read-only";
          return started(runner.run({ routine, prompt, trigger: "manual", mode }));
        }
      }
    } catch (error) {
      return no(409, (error as Error).message);
    }
    return null;
  };
}
