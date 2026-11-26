import { hasPrompt, nextDue, ROUTINE_MODES, type RoutineMode, routineHash } from "@grenier/core";
import type { RoutineView } from "@grenier/core/api";
import { newRecord, type StoreDeps, write } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import { Refusal } from "./io.ts";
import { LIBRARIAN } from "./librarian.ts";

export async function routineViews(store: Store): Promise<RoutineView[]> {
  const tops = (await store.tops.list()).map((top) => top.id);
  const out: RoutineView[] = [];
  for (const routine of await store.records.list({ tops, type: "Routine" })) {
    const approval = await store.approvals.get(routine.id, "routine");
    out.push({
      id: routine.id,
      title: routine.title,
      top: routine.top,
      author: routine.author,
      schedule: typeof routine.fields.schedule === "string" && routine.fields.schedule ? routine.fields.schedule : null,
      agent: String(routine.fields.agent ?? "claude"),
      collector: routine.fields.collector === "yes",
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
      "Built in: looks through the store for stale memories, duplicates, broken rules and orphaned tasks, and suggests fixes.",
    fields: { schedule: "daily 05:00", builtin: LIBRARIAN },
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
