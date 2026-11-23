import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { repoId, repoRoot } from "@grenier/connectors/git";
import { evalsOf, pickVersion, ROUTINE_MODES, type RoutineMode } from "@grenier/core";
import { ensureRepoSpace } from "@grenier/index";
import type { FullRecord, Run, Store } from "@grenier/store";
import { adminToken, startDaemon } from "../daemon.ts";
import { embedderLoader } from "../exploration.ts";
import { approveWorkflow, checkWorkflow, ghToken, gitHub, workflowYaml } from "../github.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";
import { LIBRARIAN } from "../librarian.ts";
import { addRoutine, approve, parseRoutine, routineViews } from "../routines.ts";
import { storeDeps } from "../runtime.ts";

/** One call to the running daemon's admin API, starting the daemon first if it is not running. */
async function daemonApi<T>(io: Io, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { paths } = environment(io);
  const daemon = await startDaemon(io);
  const response = await fetch(`http://127.0.0.1:${daemon.port}/admin${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${adminToken(paths.home)}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new CommandError(body.error ?? `the daemon answered ${response.status}`);
  return body;
}

async function findRoutine(store: Store, name: string): Promise<FullRecord> {
  const byId = await store.records.get(name);
  if (byId?.type === "Routine" && byId.retiredAt === null) return byId;
  const spaces = (await store.spaces.list()).map((space) => space.id);
  const found = (await store.records.list({ spaces, type: "Routine" })).filter(
    (record) => record.title.toLowerCase() === name.toLowerCase(),
  );
  if (found.length !== 1)
    throw new CommandError(
      found.length === 0 ? `no routine named ${name}` : `more than one routine is named ${name}; give its id`,
    );
  return found[0] as FullRecord;
}

/** Waits for the run the daemon started after `since` to finish. */
async function waitForRuns(io: Io, routineId: string, since: number, count = 1): Promise<Run[]> {
  for (;;) {
    const { runs } = await daemonApi<{ runs: Run[] }>(io, "/runs");
    const mine = runs.filter((run) => run.routineId === routineId && run.startedAt >= since);
    if (mine.length >= count && mine.every((run) => run.status !== "running")) return mine;
    await new Promise((done) => setTimeout(done, 2000));
  }
}

/** `grenier routines …`: the team's routines on this machine. */
export async function routines(argv: string[], io: Io): Promise<string[]> {
  const [action = "list", ...rest] = argv;
  const { paths, config } = environment(io);
  switch (action) {
    case "list": {
      const views = await withStore(paths, routineViews);
      if (views.length === 0) return ["The team has no routine yet. Write one: grenier routines add <file.md>"];
      return [
        ...views.map((view) => {
          const here = view.approval
            ? view.approval.current
              ? `approved, ${view.approval.mode}`
              : "changed since you approved it"
            : "not approved here";
          const production = view.versions.find((version) => version.status === "production");
          return `${view.title.padEnd(28)} ${view.trigger.padEnd(9)} v${production?.version ?? "–"}  ${here}${view.repoHere ? "" : ", its repository is not here"}  ${view.id}`;
        }),
        config.machine.routines
          ? "This machine takes runs when its rules hold: grenier machine."
          : "This machine takes no runs: grenier routines on.",
      ];
    }
    case "on":
    case "off": {
      await daemonApi(io, "/machine", { method: "PUT", body: { rules: { routines: action === "on" } } });
      return [
        action === "on"
          ? "This machine takes the team's routine runs when its rules hold. See them with: grenier machine"
          : "This machine takes no routine runs any more.",
      ];
    }
    case "add": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: { repo: { type: "string" }, space: { type: "string", default: "team" } },
      });
      const [file] = positionals;
      if (!file || positionals.length > 1) throw new UsageError("routines add takes one Markdown file");
      const path = resolve(io.cwd, file);
      if (!existsSync(path)) throw new CommandError(`no file ${path}`);
      const routine = parseRoutine(readFileSync(path, "utf8"));
      let repo: string | null = null;
      return withStore(paths, async (store) => {
        if (values.repo) {
          const root = await repoRoot(resolve(io.cwd, values.repo));
          const id = root ? await repoId(root) : null;
          if (!root || !id) throw new CommandError(`${values.repo} is not in a git repository with a commit`);
          await ensureRepoSpace(store, { root, id });
          repo = id;
        }
        const deps = await storeDeps(store, config, embedderLoader(config, paths, io.err));
        const added = await addRoutine(deps, {
          ...routine,
          repo,
          space: values.space,
        });
        return [
          added.version === 1
            ? `Added the routine ${routine.title} (${added.id}). Each machine approves it: grenier routines approve ${added.id}`
            : `Added version ${added.version} of ${routine.title}, in testing. Run its evals, then: grenier routines promote ${added.id} ${added.version}`,
        ];
      });
    }
    case "librarian": {
      return withStore(paths, async (store) => {
        const spaces = (await store.spaces.list()).map((space) => space.id);
        const existing = (await store.records.list({ spaces, type: "Routine" })).find(
          (record) => record.fields.builtin === LIBRARIAN,
        );
        if (existing) return [`The team has its librarian already (${existing.id}).`];
        const deps = await storeDeps(store, config, embedderLoader(config, paths, io.err));
        const added = await addRoutine(deps, {
          title: "Librarian",
          prompt:
            "Built in: looks through the store for stale memories, duplicates, broken rules and orphaned requests, and suggests fixes.",
          fields: { trigger: "schedule", schedule: "daily 05:00", builtin: LIBRARIAN },
          repo: null,
          space: "team",
        });
        return [
          `Added the librarian (${added.id}): every day at 05:00 UTC, one available machine looks through the store and suggests fixes.`,
          `A machine takes it once approved there: grenier routines approve ${added.id}`,
        ];
      });
    }
    case "approve": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: { mode: { type: "string", default: "read-only" }, limit: { type: "string", default: "10" } },
      });
      const [name] = positionals;
      if (!name) throw new UsageError("routines approve takes a routine's id or title");
      if (!ROUTINE_MODES.includes(values.mode as RoutineMode)) {
        throw new UsageError(`--mode takes ${ROUTINE_MODES.join(", ")}`);
      }
      return withStore(paths, async (store) => {
        const routine = await findRoutine(store, name);
        await approve(store, routine, values.mode as RoutineMode, Number(values.limit));
        return [
          `Approved ${routine.title} on this machine, ${values.mode}${values.mode === "limited" ? `, ${values.limit} actions a day` : ""}. A change to it waits for your approval again.`,
        ];
      });
    }
    case "run":
    case "eval": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: { version: { type: "string" }, task: { type: "string" } },
      });
      const [name] = positionals;
      if (!name) throw new UsageError(`routines ${action} takes a routine's id or title`);
      const routine = await withStore(paths, (store) => findRoutine(store, name));
      const cases = evalsOf(routine).length;
      if (action === "eval" && cases === 0) throw new CommandError(`${routine.title} has no eval set yet`);
      const since = Date.now();
      await daemonApi(io, `/routines/${routine.id}/${action}`, {
        body: {
          ...(values.version ? { version: Number(values.version) } : {}),
          ...(values.task ? { task: values.task } : {}),
        },
      });
      io.err(`grenier: ${action === "run" ? "running" : "running the evals of"} ${routine.title} on this machine…`);
      const done = await waitForRuns(io, routine.id, since, action === "eval" ? cases : 1);
      if (action === "run") {
        const run = done[0] as Run;
        return [`${run.status}, ${run.actions} actions`, "", run.result ?? ""];
      }
      const version = pickVersion(routine, values.version ? Number(values.version) : undefined)?.version;
      let score: number | null = null;
      for (let tries = 0; tries < 10; tries++) {
        const saved = await withStore(paths, (store) => store.state.get(`eval:${routine.id}:${version}`));
        const parsed = saved ? (JSON.parse(saved) as { score: number | null; at: number }) : null;
        if (parsed && parsed.at >= since) {
          score = parsed.score;
          break;
        }
        await new Promise((done) => setTimeout(done, 1000));
      }
      return [
        ...done.map((run) => `${run.status.padEnd(7)} ${(run.result ?? "").split("\n")[0]?.slice(0, 100) ?? ""}`),
        score === null
          ? "No case was scored by code or by a model: a person judges them in the app."
          : `Version ${version} scores ${score.toFixed(2)}.`,
      ];
    }
    case "promote": {
      const [name, version] = rest;
      if (!name || !version) throw new UsageError("routines promote takes a routine and a version");
      const routine = await withStore(paths, (store) => findRoutine(store, name));
      await daemonApi(io, `/routines/${routine.id}/promote`, { body: { version: Number(version) } });
      return [`Version ${version} of ${routine.title} is in production.`];
    }
    case "workflow": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: { file: { type: "string" } },
      });
      const [name] = positionals;
      if (!name) throw new UsageError("routines workflow takes a routine's id or title");
      return withStore(paths, async (store) => {
        const routine = await findRoutine(store, name);
        const text = values.file ? readFileSync(resolve(io.cwd, values.file), "utf8") : workflowYaml(routine);
        await approveWorkflow(store, routine.id, text);
        return values.file
          ? [`Approved ${values.file} on this machine for ${routine.title}.`]
          : [
              text.trimEnd(),
              "",
              `# Approved on this machine. Commit it as .github/workflows/${routine.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.yml;`,
              "# after an edit, approve the file again: grenier routines workflow <id> --file <path>",
            ];
      });
    }
    case "exec": {
      const [name] = rest;
      if (!name)
        throw new UsageError("routines exec takes a routine's id; it is the step of the workflow Grenier printed");
      const routine = await withStore(paths, (store) => findRoutine(store, name));
      const since = Date.now();
      await daemonApi(io, `/routines/${routine.id}/run`, {
        body: {
          checkout: io.cwd,
          task: `GitHub: ${io.env.GITHUB_EVENT_NAME ?? "run"} of ${io.env.GITHUB_REPOSITORY ?? "this repository"}`,
        },
      });
      const [run] = await waitForRuns(io, routine.id, since);
      io.out(run?.result ?? "");
      if (run?.status !== "done") throw new CommandError(`the run ${run?.status ?? "did not start"}`);
      return [];
    }
    case "hook": {
      const token = await ghToken();
      if (!token) throw new CommandError("no GitHub token on this machine (gh auth login): the job is refused");
      const refused = await withStore(paths, (store) => checkWorkflow(store, gitHub(token), io.env));
      if (refused) throw new CommandError(refused);
      return [];
    }
    default:
      throw new UsageError(
        "routines takes list, on, off, add, approve, run, eval, promote, workflow, librarian or exec",
      );
  }
}

/** `grenier machine [set <rule> <value>]`: this machine's state, and the rules that keep routines out of the way. */
export async function machine(argv: string[], io: Io): Promise<string[]> {
  const [action, key, value] = argv;
  if (action === "set") {
    if (!key || value === undefined) throw new UsageError("machine set takes a rule and a value");
    const parsed: string | number | boolean =
      value === "true" || value === "false" ? value === "true" : /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    await daemonApi(io, "/machine", { method: "PUT", body: { rules: { [key]: parsed } } });
  } else if (action !== undefined) {
    throw new UsageError("machine takes nothing, or: set <rule> <value>");
  }
  const state = await daemonApi<{
    state: string;
    room: number;
    reasons: string[];
    rules: Record<string, unknown>;
  }>(io, "/machine");
  return [
    `${state.state}${state.reasons.length > 0 ? `: ${state.reasons.join("; ")}` : ""}`,
    "",
    ...Object.entries(state.rules).map(([rule, setting]) => `  ${rule.padEnd(13)} ${String(setting)}`),
    "",
    "Change one with: grenier machine set <rule> <value>",
  ];
}
