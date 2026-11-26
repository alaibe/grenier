import { hasPrompt, nextDue, ROUTINE_MODES, type RoutineMode, routineHash } from "@grenier/core";
import type { RoutineView } from "@grenier/core/api";
import { newRecord, type StoreDeps, write } from "@grenier/index";
import { type FullRecord, type Store, toInput } from "@grenier/store";
import { BUILTINS } from "./builtins.ts";
import { Refusal } from "./io.ts";

/** How many actions a run in `limited` may take a day, unless its approval says otherwise. */
export const DEFAULT_ACTION_LIMIT = 10;

/** How this machine's person approved a routine, and whether it is as it was then; null when they didn't. */
export async function routineApproval(store: Store, routine: FullRecord): Promise<RoutineView["approval"]> {
  const approval = await store.approvals.get(routine.id, "routine");
  if (!approval) return null;
  return {
    mode: (approval.settings.mode as RoutineMode) ?? "read-only",
    limit: Number(approval.settings.limit ?? DEFAULT_ACTION_LIMIT),
    current: approval.hash === (await routineHash(routine)),
  };
}

/** The team's routines as the app lists them; one that names no agent runs this machine's. */
export async function routineViews(store: Store, machineAgent: string): Promise<RoutineView[]> {
  const tops = (await store.tops.list()).map((top) => top.id);
  const out: RoutineView[] = [];
  for (const routine of await store.records.list({ tops, type: "Routine" })) {
    out.push({
      id: routine.id,
      title: routine.title,
      top: routine.top,
      author: routine.author,
      schedule: typeof routine.fields.schedule === "string" && routine.fields.schedule ? routine.fields.schedule : null,
      agent: typeof routine.fields.agent === "string" ? routine.fields.agent : machineAgent,
      collector: routine.fields.collector === "yes",
      builtin: typeof routine.fields.builtin === "string" ? routine.fields.builtin : null,
      prompt: routine.body,
      approval: await routineApproval(store, routine),
    });
  }
  return out;
}

/** Approves a routine as it is now, on this machine, in a mode. */
export async function approve(
  store: Store,
  routine: FullRecord,
  mode: RoutineMode,
  limit = DEFAULT_ACTION_LIMIT,
): Promise<void> {
  if (!ROUTINE_MODES.includes(mode)) throw new Refusal(`a mode is one of ${ROUTINE_MODES.join(", ")}`);
  if (!hasPrompt(routine)) throw new Refusal("the routine says nothing to do yet: an admin gives it its text first");
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

/** Adds one of the routines Grenier ships, once: a collector runs on its owner's machines and writes to their Me. */
export async function addBuiltin(deps: StoreDeps, id: string): Promise<{ id: string; added: boolean }> {
  const builtin = BUILTINS[id];
  if (!builtin) throw new Refusal(`Grenier ships no routine ${id}`);
  const tops = (await deps.store.tops.list()).map((top) => top.id);
  const existing = (await deps.store.records.list({ tops, type: "Routine" })).find(
    (record) => record.fields.builtin === id,
  );
  if (existing) return { id: existing.id, added: false };
  const added = await addRoutine(deps, {
    title: builtin.title,
    prompt: builtin.prompt,
    fields: { schedule: builtin.schedule, builtin: id, ...(builtin.collector ? { collector: "yes" } : {}) },
    top: "team",
  });
  return { id: added.id, added: true };
}

/** A routine as the app's form gives it: what it does, when (no schedule: by hand only), and with which agent. */
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
  return {
    title,
    prompt,
    fields: {
      ...(schedule ? { schedule } : {}),
      ...(input.agent === "codex" ? { agent: "codex" } : {}),
      ...(input.collector === true ? { collector: "yes" } : {}),
    },
  };
}

/** The fields a routine keeps, from the form: what the form leaves out goes, but a built-in stays built in. */
function routineFields(
  deps: StoreDeps,
  input: { fields: Record<string, unknown> },
  before?: FullRecord,
): Record<string, unknown> {
  const owner = before?.fields.collector === "yes" ? before.fields.owner : deps.me.member;
  return {
    ...input.fields,
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
    top: string;
    folder?: string;
  },
): Promise<{ id: string }> {
  const tops = (await deps.store.tops.list()).map((top) => top.id);
  const taken = (await deps.store.records.list({ tops, type: "Routine" })).some(
    (record) => record.title.toLowerCase() === input.title.toLowerCase(),
  );
  if (taken) throw new Refusal(`there is a routine named ${input.title} already: edit it`);
  const routine = newRecord(deps.me, {
    top: input.top,
    type: "Routine",
    title: input.title,
    folder: input.folder ?? "",
    body: input.prompt,
    fields: routineFields(deps, input),
  });
  await write(deps, routine);
  return { id: routine.id };
}

/** Changes a routine in place: a run going on keeps what it started with, and the next one takes the change. */
export async function editRoutine(
  deps: StoreDeps,
  routine: FullRecord,
  input: { title: string; prompt: string; fields: Record<string, unknown> },
): Promise<void> {
  const rest = toInput(routine);
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
