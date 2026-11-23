import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  type Config,
  ConfigError,
  parseConfig,
  ROUTINE_MODES,
  type RoutineMode,
  type RoutineVersion,
  routineHash,
  versionsOf,
} from "@grenier/core";
import type { GrenierPaths } from "@grenier/core/node";
import { newId, type StoreDeps, type TeamClient, teamApi, write } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import type { Reply, Route } from "./host.ts";
import { CommandError, writeAtomically } from "./io.ts";
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
  space: string;
  author: string;
  trigger: string;
  schedule: string | null;
  repo: string | null;
  /** Whether the routine's repository is on this machine. */
  repoHere: boolean;
  agent: string;
  collector: boolean;
  tools: string[];
  versions: RoutineVersion[];
  evals: number;
  /** How this machine's person approved it: its mode, and whether it changed since. */
  approval: { mode: RoutineMode; limit: number; current: boolean } | null;
}

export async function routineViews(store: Store): Promise<RoutineView[]> {
  const spaces = (await store.spaces.list()).map((space) => space.id);
  const out: RoutineView[] = [];
  for (const routine of await store.records.list({ spaces, type: "Routine" })) {
    const approval = await store.approvals.get(routine.id, "routine");
    const repo = typeof routine.fields.repo === "string" && routine.fields.repo ? routine.fields.repo : null;
    out.push({
      id: routine.id,
      title: routine.title,
      space: routine.space,
      author: routine.author,
      trigger: String(routine.fields.trigger ?? "request"),
      schedule: typeof routine.fields.schedule === "string" ? routine.fields.schedule : null,
      repo,
      repoHere: repo ? Boolean((await store.spaces.get(`repo:${repo}`))?.root) : true,
      agent: String(routine.fields.agent ?? "claude"),
      collector: routine.fields.collector === "yes",
      tools: Array.isArray(routine.fields.tools) ? routine.fields.tools.map(String) : [],
      versions: versionsOf(routine),
      evals: Array.isArray(routine.fields.evals) ? routine.fields.evals.length : 0,
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

/** Scores per version, from the eval runs the team store kept: the mean of the scored ones. */
export function scores(runs: { version: number; kind: string; score: number | null }[]): Map<number, number> {
  const sums = new Map<number, { total: number; count: number }>();
  for (const run of runs) {
    if (run.kind !== "eval" || run.score === null) continue;
    const sum = sums.get(run.version) ?? { total: 0, count: 0 };
    sums.set(run.version, { total: sum.total + run.score, count: sum.count + 1 });
  }
  return new Map([...sums].map(([version, sum]) => [version, sum.total / sum.count]));
}

/**
 * Puts a version in production, retiring the one there: only once it scored at least as well on the eval set, or
 * when the routine has no version in production yet.
 */
export async function promote(
  deps: StoreDeps,
  routine: FullRecord,
  version: number,
  runs: { version: number; kind: string; score: number | null }[],
): Promise<RoutineVersion[]> {
  const versions = versionsOf(routine);
  const next = versions.find((entry) => entry.version === version);
  if (!next) throw new CommandError(`${routine.title} has no version ${version}`);
  const current = versions.find((entry) => entry.status === "production");
  if (current && current.version !== version) {
    const scored = scores(runs);
    const mine = scored.get(version);
    if (mine === undefined) throw new CommandError(`run version ${version}'s evals first: grenier routines eval`);
    const theirs = scored.get(current.version) ?? 0;
    if (mine < theirs) {
      throw new CommandError(
        `version ${version} scores ${mine.toFixed(2)}, below version ${current.version}'s ${theirs.toFixed(2)}`,
      );
    }
  }
  const updated = versions.map((entry) =>
    entry.version === version
      ? { ...entry, status: "production" as const }
      : entry.status === "production"
        ? { ...entry, status: "retired" as const }
        : entry,
  );
  const { seq: _seq, hits: _hits, ...rest } = routine;
  await write(deps, { ...rest, fields: { ...rest.fields, versions: updated }, updatedAt: Date.now() }, routine);
  return updated;
}

/** A routine from a Markdown file: its front matter sets the fields, its text is the prompt. */
export function parseRoutine(text: string): { title: string; prompt: string; fields: Record<string, unknown> } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n?/g, "\n"));
  if (!match) throw new CommandError("a routine file starts with front matter between --- lines, then its prompt");
  const front = new Map<string, string>();
  for (const line of (match[1] as string).split("\n")) {
    const pair = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (pair) front.set(pair[1] as string, (pair[2] as string).replace(/^["']|["']$/g, ""));
  }
  const title = front.get("title");
  if (!title) throw new CommandError("a routine needs a title in its front matter");
  const prompt = (match[2] as string).trim();
  if (!prompt) throw new CommandError("a routine needs a prompt after its front matter");
  const list = (value: string | undefined) =>
    (value ?? "")
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  return {
    title,
    prompt,
    fields: {
      trigger: front.get("trigger") ?? "request",
      ...(front.get("schedule") ? { schedule: front.get("schedule") } : {}),
      ...(front.get("tools") ? { tools: list(front.get("tools")) } : {}),
      ...(front.get("agent") ? { agent: front.get("agent") } : {}),
      ...(front.get("collector") ? { collector: front.get("collector") === "yes" ? "yes" : "no" } : {}),
    },
  };
}

/** Writes a new routine, or a new testing version of the one with the same title. */
export async function addRoutine(
  deps: StoreDeps,
  input: { title: string; prompt: string; fields: Record<string, unknown>; repo: string | null; space: string },
): Promise<{ id: string; version: number }> {
  const spaces = (await deps.store.spaces.list()).map((space) => space.id);
  const existing = (await deps.store.records.list({ spaces, type: "Routine" })).find(
    (record) => record.title.toLowerCase() === input.title.toLowerCase(),
  );
  const now = Date.now();
  if (existing) {
    const versions = versionsOf(existing);
    const version = Math.max(0, ...versions.map((entry) => entry.version)) + 1;
    const { seq: _seq, hits: _hits, ...rest } = existing;
    await write(
      deps,
      {
        ...rest,
        fields: {
          ...rest.fields,
          ...input.fields,
          ...(input.repo ? { repo: input.repo } : {}),
          versions: [...versions, { version, prompt: input.prompt, status: "testing" }],
        },
        updatedAt: now,
      },
      existing,
    );
    return { id: existing.id, version };
  }
  const id = newId();
  await write(deps, {
    id,
    space: input.space,
    type: "Routine",
    kind: null,
    title: input.title,
    body: "",
    fields: {
      ...(input.fields.collector === "yes" ? { owner: deps.me.member } : {}),
      ...input.fields,
      ...(input.repo ? { repo: input.repo } : {}),
      versions: [{ version: 1, prompt: input.prompt, status: "production" }],
    },
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
  return { id, version: 1 };
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
  const teamRuns = async (routine?: string) => {
    const team = deps.team();
    if (!team) return [];
    return (
      await teamApi<{
        runs: {
          id: string;
          version: number;
          kind: string;
          score: number | null;
          task_id: string | null;
          routine_id: string;
        }[];
      }>(team, `/api/runs${routine ? `?routine=${encodeURIComponent(routine)}` : ""}`).catch(() => ({ runs: [] }))
    ).runs;
  };
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

    const thumbs = /^\/runs\/([^/]+)\/thumbs$/.exec(path);
    if (thumbs && method === "POST") {
      const team = deps.team();
      if (!team) return no(409, "this machine is in no team");
      const id = decodeURIComponent(thumbs[1] as string);
      const up = input.up === true;
      await teamApi(team, `/api/runs/${encodeURIComponent(id)}/thumbs`, { body: { up } });
      const run = (await teamRuns()).find((entry) => entry.id === id);
      const task = run?.task_id ? await store.records.get(run.task_id) : undefined;
      const routine = run ? await store.records.get(run.routine_id) : undefined;
      if (task && routine) {
        const result = String(task.fields.result ?? "").slice(0, 600);
        const evals = Array.isArray(routine.fields.evals) ? routine.fields.evals : [];
        const { seq: _seq, hits: _hits, ...rest } = routine;
        await write(
          await deps.storeDeps(),
          {
            ...rest,
            fields: {
              ...rest.fields,
              evals: [
                ...evals,
                {
                  input: `${task.title}\n\n${task.body}`.trim(),
                  expect: up ? `A result as good as this one: ${result}` : `Not like this result: ${result}`,
                  judge: "person",
                },
              ],
            },
            updatedAt: Date.now(),
          },
          routine,
        );
      }
      return ok({ thumbs: up, addedToEvals: Boolean(task && routine) });
    }

    const match = /^\/routines\/([^/]+)\/(approve|run|eval|promote)$/.exec(path);
    if (!match) return null;
    const routine = await store.records.get(decodeURIComponent(match[1] as string));
    if (routine?.type !== "Routine" || routine.retiredAt !== null) return no(404, "no such routine");
    const approval = await store.approvals.get(routine.id, "routine");
    const mode =
      approval && approval.hash === (await routineHash(routine))
        ? ((approval.settings.mode as RoutineMode) ?? "read-only")
        : "read-only";
    const versionOf = () => {
      const asked = typeof input.version === "number" ? input.version : undefined;
      const versions = versionsOf(routine);
      return asked !== undefined
        ? versions.find((entry) => entry.version === asked)
        : versions.find((entry) => entry.status === "production");
    };
    try {
      switch (`${method} ${match[2]}`) {
        case "POST approve":
          await approve(store, routine, (input.mode as RoutineMode) ?? "read-only", Number(input.limit ?? 10));
          void runner.tick(true);
          return ok({ approved: routine.id });
        case "DELETE approve":
          await store.approvals.remove(routine.id, "routine");
          return ok({ removed: routine.id });
        case "POST run": {
          const version = versionOf();
          if (!version) return no(409, "the routine has no such version");
          if (runner.inRun) return no(409, "a run is going on this machine already");
          const prompt =
            typeof input.task === "string" && input.task.trim() ? input.task.trim() : "Run now, as your prompt says.";
          const checkout =
            typeof input.checkout === "string" && isAbsolute(input.checkout) ? input.checkout : undefined;
          return started(
            runner.run({
              routine,
              version,
              prompt,
              trigger: checkout ? "github" : "manual",
              mode,
              ...(checkout ? { checkout } : {}),
            }),
          );
        }
        case "POST eval": {
          const version = versionOf();
          if (!version) return no(409, "the routine has no such version");
          if (runner.inRun) return no(409, "a run is going on this machine already");
          return started(
            runner
              .evaluate(routine, version, mode)
              .then((result) =>
                store.state.set(
                  `eval:${routine.id}:${version.version}`,
                  JSON.stringify({ score: result.score, at: Date.now() }),
                ),
              ),
          );
        }
        case "POST promote": {
          const versions = await promote(
            await deps.storeDeps(),
            routine,
            Number(input.version),
            await teamRuns(routine.id),
          );
          return ok({ versions });
        }
      }
    } catch (error) {
      return no(409, (error as Error).message);
    }
    return null;
  };
}
