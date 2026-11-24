import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { repoId, repoRoot } from "@grenier/connectors/git";
import { ensureRepoTop, placeOf } from "@grenier/index";
import type { FullRecord, Run, Store } from "@grenier/store";
import { adminToken, startDaemon } from "../daemon.ts";
import { embedderLoader } from "../exploration.ts";
import { approveWorkflow, checkWorkflow, ghToken, gitHub, workflowYaml } from "../github.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";
import { LIBRARIAN } from "../librarian.ts";
import { addRoutine, parseRoutine } from "../routines.ts";
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
  const tops = (await store.tops.list()).map((top) => top.id);
  const found = (await store.records.list({ tops, type: "Routine" })).filter(
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

/** `grenier routines …`: writing the team's routines, and running one from a GitHub workflow. */
export async function routines(argv: string[], io: Io): Promise<string[]> {
  const [action, ...rest] = argv;
  const { paths, config } = environment(io);
  switch (action) {
    case "add": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: { repo: { type: "string" }, folder: { type: "string", default: "Team" } },
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
          await ensureRepoTop(store, { root, id });
          repo = id;
        }
        const deps = await storeDeps(store, config, embedderLoader(config, paths, io.err));
        let place: { top: string; folder: string };
        try {
          place = await placeOf(store, { id: "cli", name: "cli", scopes: ["*"] }, values.folder);
        } catch (error) {
          throw new CommandError((error as Error).message);
        }
        const added = await addRoutine(deps, { ...routine, repo, ...place });
        return [
          added.version === 1
            ? `Added the routine ${routine.title} (${added.id}). Each machine approves it on the app's Routines screen.`
            : `Added version ${added.version} of ${routine.title}, in testing. Run its evals and promote it on the app's Routines screen.`,
        ];
      });
    }
    case "librarian": {
      return withStore(paths, async (store) => {
        const tops = (await store.tops.list()).map((top) => top.id);
        const existing = (await store.records.list({ tops, type: "Routine" })).find(
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
          top: "team",
        });
        return [
          `Added the librarian (${added.id}): every day at 05:00 UTC, one available machine looks through the store and suggests fixes.`,
          "A machine takes it once approved there, on the app's Routines screen.",
        ];
      });
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
      throw new UsageError("routines takes add, workflow, librarian or exec");
  }
}
