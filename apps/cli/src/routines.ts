import { isRunning, nextDue, ROUTINE_MODES, type RoutineMode, runSettings } from "@grenier/core";
import type { RoutineView } from "@grenier/core/api";
import { newRecord, type StoreDeps, write } from "@grenier/index";
import { type FullRecord, type Store, toInput } from "@grenier/store";
import { Refusal } from "./io.ts";

/** What every routine command says without a team: routines exist only in one. */
export const NO_TEAM = "routines run on the team's machines: start or join a team first";

/** The team's routines as the app lists them; one that names no agent runs this machine's. */
export async function routineViews(store: Store, machineAgent: string): Promise<RoutineView[]> {
  return (await store.records.list({ tops: ["team"], type: "Routine" })).map((routine) => ({
    id: routine.id,
    title: routine.title,
    author: routine.author,
    schedule: typeof routine.fields.schedule === "string" && routine.fields.schedule ? routine.fields.schedule : null,
    agent: typeof routine.fields.agent === "string" ? routine.fields.agent : machineAgent,
    prompt: routine.body,
    ...runSettings(routine.fields),
    state: isRunning(routine) ? "running" : "paused",
  }));
}

/** A routine as the app's form gives it: what it does, when (no schedule: by hand only), with which agent, and how. */
export function routineFromForm(input: Record<string, unknown>): {
  title: string;
  prompt: string;
  fields: Record<string, unknown>;
} {
  const title = String(input.title ?? "").trim();
  const prompt = String(input.prompt ?? "").trim();
  if (!title || !prompt) throw new Refusal("a routine needs a name and what it does");
  const schedule = String(input.schedule ?? "").trim();
  if (schedule && nextDue(schedule, Date.now()) === null) {
    throw new Refusal('a schedule reads "hourly", "daily 05:00", "weekdays 09:00" or "mon 09:00"');
  }
  const mode = String(input.mode ?? "read-only") as RoutineMode;
  if (!ROUTINE_MODES.includes(mode)) throw new Refusal(`a mode is one of ${ROUTINE_MODES.join(", ")}`);
  const limit = input.limit === undefined || input.limit === "" ? undefined : Number(input.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new Refusal("a limit is a number of actions a day, 1 or more");
  }
  return {
    title,
    prompt,
    fields: {
      ...(schedule ? { schedule } : {}),
      ...(input.agent === "codex" ? { agent: "codex" } : {}),
      mode,
      ...(mode === "limited" && limit !== undefined ? { limit } : {}),
    },
  };
}

/** Writes a new routine, running; its text is what each run does. */
export async function addRoutine(
  deps: StoreDeps,
  input: { title: string; prompt: string; fields: Record<string, unknown> },
): Promise<{ id: string }> {
  const taken = (await deps.store.records.list({ tops: ["team"], type: "Routine" })).some(
    (record) => record.title.toLowerCase() === input.title.toLowerCase(),
  );
  if (taken) throw new Refusal(`there is a routine named ${input.title} already: edit it`);
  const routine = newRecord(deps.me, {
    top: "team",
    type: "Routine",
    title: input.title,
    body: input.prompt,
    fields: { ...input.fields, state: "running" },
  });
  await write(deps, routine);
  return { id: routine.id };
}

/** Changes a routine in place, running or paused as it was: a run going on keeps what it started with. */
export async function editRoutine(
  deps: StoreDeps,
  routine: FullRecord,
  input: { title: string; prompt: string; fields: Record<string, unknown> },
): Promise<void> {
  await write(
    deps,
    {
      ...toInput(routine),
      title: input.title,
      body: input.prompt,
      fields: { ...input.fields, state: isRunning(routine) ? "running" : "paused" },
      updatedAt: Date.now(),
    },
    routine,
  );
}

/** Pauses a routine or sets it running again: only an admin's change reaches the team. */
export async function setRunning(deps: StoreDeps, routine: FullRecord, running: boolean): Promise<void> {
  await write(
    deps,
    {
      ...toInput(routine),
      fields: { ...routine.fields, state: running ? "running" : "paused" },
      updatedAt: Date.now(),
    },
    routine,
  );
}
