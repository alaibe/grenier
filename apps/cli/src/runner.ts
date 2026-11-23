import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { setPriority, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  allowedTools,
  type Config,
  evalsOf,
  isAction,
  judgeByCode,
  pickVersion,
  type RoutineMode,
  type RoutineVersion,
  repoSpace,
  routineHash,
  toolsOf,
} from "@grenier/core";
import type { RunGuard } from "@grenier/gateway";
import { newId, type StoreDeps, type TeamClient, teamApi, write } from "@grenier/index";
import type { FullRecord, Session, Store } from "@grenier/store";
import { newSessionId } from "./commands/run.ts";
import {
  ensureRunner,
  gitHub,
  githubRepo,
  jitConfig,
  runJob,
  runnerPlatform,
  waitingJob,
  writeHook,
} from "./github.ts";
import { LIBRARIAN, librarian } from "./librarian.ts";
import { type Availability, availability, type Probes, systemProbes } from "./machine.ts";

export interface AgentResult {
  code: number;
  text: string;
}

/** Runs the agent; tests pass a stand-in. */
export type Spawner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<AgentResult>;

/** What the runner needs to take GitHub jobs: the person's token, and how to start this program again. */
export interface GitHubDeps {
  /** Grenier's folder, where the runner binary is kept. */
  home: string;
  self: readonly string[];
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
}

export interface RunnerDeps {
  store: Store;
  config: () => Config;
  port: number;
  team: () => TeamClient | null;
  storeDeps: () => Promise<StoreDeps>;
  /** Tells the team store this machine's state, over the live connection. */
  tell: (state: Record<string, unknown>) => Promise<void>;
  /** A round of sync now, so a result reaches the team at once. */
  sync: () => Promise<void>;
  log: (line: string) => void;
  notify?: (title: string, message: string) => void;
  probes?: Probes;
  spawner?: Spawner;
  github?: GitHubDeps;
  now?: () => number;
}

interface Current {
  runId: string;
  sessionId: string;
  routineId: string;
  allowed: Set<string>;
  mode: RoutineMode;
  limit: number;
  /** Actions of this routine's earlier runs today, against `limited`'s daily allowance. */
  usedToday: number;
  actions: number;
  cut: string | null;
  /** Stops the agent: the run was cut off, or its machine is no longer available. */
  stop: AbortController;
}

export interface RunOutcome {
  id: string;
  status: "done" | "failed" | "cut";
  result: string;
  cost: number;
  actions: number;
}

/** How long a run waits for its person to leave the machine again before its task goes to another machine. */
const HOLD_LIMIT = 10 * 60 * 1000;
const LEASE_RENEW = 2 * 60 * 1000;
const CHECK_EVERY = 60 * 1000;
const CLAIM_EVERY = 5 * 60 * 1000;
const MAX_RESULT = 20_000;
/** Claude Code's built-in tools a routine may be given; `--tools` makes only these available. */
const CLAUDE_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "MultiEdit",
  "Write",
  "Bash",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
];

/** Spawns an agent at the lowest priority and collects what it prints. */
export const spawnAgent: Spawner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (child.pid) {
      try {
        setPriority(child.pid, 19);
      } catch {
        // Not allowed here: it runs at the normal priority.
      }
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once("error", (error) =>
      resolve({
        code: error.name === "AbortError" ? 130 : 127,
        text: error.name === "AbortError" ? "stopped" : `cannot run ${command}: ${error.message}`,
      }),
    );
    child.once("exit", (code) => resolve({ code: code ?? 1, text: code === 0 ? out : `${out}\n${err}`.trim() }));
  });

const git = async (root: string, args: string[]) =>
  (await promisify(execFile)("git", ["-C", root, ...args], { encoding: "utf8" })).stdout;

/** This machine's part in the team's routines: takes the work offered and runs it in a clean checkout. */
export class Runner {
  #current: Current | null = null;
  #last: Availability | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastClaim = 0;
  #lastGitHub = 0;
  #githubJob = false;
  readonly probes: Probes;
  readonly spawner: Spawner;
  readonly now: () => number;

  constructor(readonly deps: RunnerDeps) {
    this.probes = deps.probes ?? systemProbes();
    this.spawner = deps.spawner ?? spawnAgent;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), CHECK_EVERY);
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  get running(): boolean {
    return this.#current !== null || this.#githubJob;
  }

  /** Whether a routine's run is going; a GitHub job's runner alone leaves room for the run it asks for. */
  get inRun(): boolean {
    return this.#current !== null;
  }

  /** The machine's state now, from its person's rules. */
  async state(): Promise<Availability> {
    const config = this.deps.config();
    if (!config.machine.routines) return { state: "away", room: 0, reasons: ["routines are off on this machine"] };
    return availability(config.machine, this.probes, this.running);
  }

  /** Checks the rules, says so when the state changed, and asks for work when available. */
  async tick(force = false): Promise<void> {
    if (!this.deps.team()) return;
    const now = await this.state();
    const changed = !this.#last || this.#last.state !== now.state || Math.abs(this.#last.room - now.room) > 0.2;
    if (changed) {
      this.#last = now;
      await this.deps.tell({
        state: now.state,
        room: now.room,
        repos: await this.#repos(),
        agents: [this.deps.config().machine.agent],
      });
    }
    if (now.state !== "available" || this.running) return;
    if (force || changed || this.now() - this.#lastClaim >= CLAIM_EVERY) await this.claim();
    if (!this.running && this.deps.github && this.now() - this.#lastGitHub >= CLAIM_EVERY) await this.#gitHubJob();
  }

  /** Takes one queued GitHub job on a just-in-time runner for that job only, never for a public repository. */
  async #gitHubJob(): Promise<void> {
    const github = this.deps.github as GitHubDeps;
    this.#lastGitHub = this.now();
    const workflows = new Set((await this.deps.store.approvals.list("workflow")).map((approval) => approval.recordId));
    if (workflows.size === 0) return;
    const platform = runnerPlatform(process.platform, process.arch);
    const token = platform ? await github.token() : null;
    if (!platform || !token) return;
    const api = gitHub(token, github.fetch);
    for (const id of workflows) {
      const routine = await this.deps.store.records.get(id);
      const repoId = typeof routine?.fields.repo === "string" ? routine.fields.repo : "";
      const root = repoId ? (await this.deps.store.spaces.get(repoSpace(repoId)))?.root : null;
      if (!routine || routine.retiredAt !== null || !root) continue;
      const approval = await this.deps.store.approvals.get(id, "routine");
      if (!approval || approval.hash !== (await routineHash(routine))) continue;
      try {
        const remote = githubRepo(await git(root, ["remote", "get-url", "origin"]));
        if (!remote || !(await waitingJob(api, remote.owner, remote.repo))) continue;
        const dir = await ensureRunner(github.home, platform, github.fetch);
        const { hook, bin } = writeHook(dir, github.self);
        const name = `grenier-${(await this.deps.storeDeps()).me.device}-${newId().slice(0, 6)}`;
        const config = await jitConfig(api, remote.owner, remote.repo, name);
        this.#githubJob = true;
        await this.tick();
        this.deps.log(`grenier: took a GitHub job of ${routine.title} in ${remote.owner}/${remote.repo}`);
        void runJob(
          dir,
          config,
          { ...process.env, ACTIONS_RUNNER_HOOK_JOB_STARTED: hook, GRENIER_BIN: bin },
          this.deps.log,
        )
          .then((code) => this.deps.log(`grenier: the GitHub job of ${routine.title} ended (${code})`))
          .finally(() => {
            this.#githubJob = false;
            void this.tick();
          });
        return;
      } catch (error) {
        this.deps.log(`grenier: could not take a GitHub job of ${routine.title}: ${(error as Error).message}`);
      }
    }
  }

  async #repos(): Promise<string[]> {
    return (await this.deps.store.spaces.list())
      .filter((space) => space.kind === "repo" && space.root && space.repoId)
      .map((space) => space.repoId as string);
  }

  /** Asks the team store for a task, and runs it if this machine's person approved its routine as it is now. */
  async claim(): Promise<void> {
    const team = this.deps.team();
    if (!team || this.#current) return;
    this.#lastClaim = this.now();
    let offer: { task: FullRecord; routine: FullRecord } | null;
    try {
      offer = (
        await teamApi<{ offer: { task: FullRecord; routine: FullRecord } | null }>(team, "/api/work/claim", {
          body: {},
        })
      ).offer;
    } catch (error) {
      this.deps.log(`grenier: could not ask the team for work: ${(error as Error).message}`);
      return;
    }
    if (!offer) return;
    const { task, routine } = offer;
    const decline = async (why: string) => {
      this.deps.log(`grenier: declined ${task.title} (${routine.title}): ${why}`);
      await teamApi(team, `/api/work/${encodeURIComponent(task.id)}/decline`, { body: {} }).catch(() => undefined);
    };
    const approval = await this.deps.store.approvals.get(routine.id, "routine");
    if (!approval || approval.hash !== (await routineHash(routine))) {
      this.deps.notify?.(
        "A routine waits for your approval",
        `${routine.title}: approve it on the app's Routines screen.`,
      );
      return decline(approval ? "it changed since it was approved here" : "it is not approved here");
    }
    const asked = typeof task.fields.version === "number" ? task.fields.version : undefined;
    const version = pickVersion(routine, asked);
    if (!version) return decline(asked ? `it has no version ${asked} to run` : "it has no version in production");
    await this.run({
      routine,
      version,
      task,
      trigger: "request",
      mode: (approval.settings.mode as RoutineMode) ?? "read-only",
    });
  }

  /** The guard the proxy holds the current run to; null for any other session. */
  guard(session: Session): RunGuard | null {
    const current = this.#current;
    if (!current || session.runId !== current.runId) return null;
    return {
      allows: (tool) => {
        const allowed = current.allowed.has(tool) || [...current.allowed].some((entry) => entry.startsWith(`${tool}(`));
        if (!allowed) return false;
        if (isAction(tool)) {
          if (current.mode === "limited" && current.usedToday + current.actions >= current.limit) return false;
          current.actions++;
        }
        return true;
      },
      cut: (tool) => {
        current.cut = tool;
        this.deps.log(`grenier: cut the run of ${current.routineId} off: it called ${tool}`);
        current.stop.abort();
      },
      hold: async (signal) => {
        const until = this.now() + HOLD_LIMIT;
        while (current.cut === null && !signal.aborted) {
          const rules = this.deps.config();
          const now = rules.machine.routines ? await availability(rules.machine, this.probes, false) : null;
          if (now?.state === "available") return true;
          if (!now || this.now() > until) break;
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        }
        current.stop.abort();
        return false;
      },
    };
  }

  /** One run of a routine's version: for a task, by hand, or for an eval case. */
  async run(input: {
    routine: FullRecord;
    version: RoutineVersion;
    task?: FullRecord;
    /** For an eval: the case's input, in place of a task. */
    prompt?: string;
    /** A checkout to run in, as a GitHub job's; otherwise a clean one is made from the repository here. */
    checkout?: string;
    trigger: "request" | "manual" | "eval" | "github";
    mode: RoutineMode;
  }): Promise<RunOutcome> {
    if (this.#current) throw new Error("a run is going on this machine already");
    const { routine, version, task, mode } = input;
    const store = this.deps.store;
    const config = this.deps.config();
    const agent = typeof routine.fields.agent === "string" ? routine.fields.agent : config.machine.agent;
    const repoId = typeof routine.fields.repo === "string" && routine.fields.repo ? routine.fields.repo : null;
    const root = repoId ? (await store.spaces.get(repoSpace(repoId)))?.root : null;
    const runId = newId();
    const sessionId = newSessionId();
    const startedAt = this.now();
    const team = this.deps.team();
    const report = (fields: Record<string, unknown>) =>
      team
        ? teamApi(team, "/api/runs", {
            body: {
              id: runId,
              routineId: routine.id,
              ...(task ? { taskId: task.id } : {}),
              version: version.version,
              kind: input.trigger === "eval" ? "eval" : "run",
              startedAt,
              ...fields,
            },
          }).catch(() => undefined)
        : Promise.resolve(undefined);

    // The run is listed before anything can fail, so whoever waits for it sees it end.
    await store.runs.add({
      id: runId,
      routineId: routine.id,
      taskId: task?.id ?? null,
      version: version.version,
      sessionId,
      trigger: input.trigger,
      status: "running",
      startedAt,
      endedAt: null,
      actions: 0,
      result: null,
    });
    if (repoId && !root && !input.checkout) {
      return this.#finish(
        runId,
        { status: "failed", result: "the routine's repository is not on this machine", cost: 0, actions: 0 },
        report,
        task,
      );
    }
    const folder = mkdtempSync(join(tmpdir(), "grenier-run-"));
    const fresh = Boolean(root && !input.checkout);
    const checkout = input.checkout ?? (root ? join(folder, basename(root)) : folder);
    const midnight = new Date(startedAt).setHours(0, 0, 0, 0);
    const usedToday = (await store.runs.list({ routineId: routine.id, since: midnight })).reduce(
      (total, run) => total + run.actions,
      0,
    );
    this.#current = {
      runId,
      sessionId,
      routineId: routine.id,
      allowed: new Set(allowedTools(mode, toolsOf(routine))),
      mode,
      limit: Number((await store.approvals.get(routine.id, "routine"))?.settings.limit ?? 10),
      usedToday,
      actions: 0,
      cut: null,
      stop: new AbortController(),
    };
    let renew: ReturnType<typeof setInterval> | undefined;
    try {
      if (fresh && root) await git(root, ["worktree", "add", "--detach", checkout, "HEAD"]);
      await store.sessions.create({
        id: sessionId,
        client: agent,
        cwd: checkout,
        repoRoot: root || input.checkout ? checkout : null,
        repoId,
        startedAt,
        runId,
      });
      await report({ status: "running" });
      if (task) await this.#setTask(task, { status: "doing" });
      if (task && team) {
        renew = setInterval(() => {
          void teamApi(team, `/api/work/${encodeURIComponent(task.id)}/renew`, { body: {} }).catch(() => undefined);
        }, LEASE_RENEW);
      }

      if (routine.fields.builtin === LIBRARIAN) {
        const found = await librarian(await this.deps.storeDeps());
        return await this.#finish(
          runId,
          {
            status: "done",
            result:
              found.suggested === 0
                ? "The store is in order: nothing to suggest."
                : `${found.suggested} suggestions, to accept or dismiss in the store:\n${found.lines.join("\n")}`,
            cost: 0,
            actions: 0,
          },
          report,
          task,
        );
      }
      const prompt = [
        version.prompt,
        input.prompt ?? (task ? `## The task\n\n${task.title}\n\n${task.body}`.trim() : ""),
        mode === "shadow"
          ? "Change nothing. End with the exact actions you would take, one per line, each with the tool and its input."
          : "",
        mode === "read-only" ? "You may read only: answer with what you found and what you would do next." : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const base = `http://127.0.0.1:${this.deps.port}/s/${sessionId}`;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ANTHROPIC_BASE_URL: base,
        OPENAI_BASE_URL: `${base}/openai/v1`,
        GRENIER_SESSION: sessionId,
        GRENIER_RUN_SPACE: routine.fields.collector === "yes" ? "me" : routine.space === "me" ? "me" : "team",
      };
      const allowed = [...this.#current.allowed];
      const builtIn = [
        ...new Set(allowed.filter((tool) => !tool.startsWith("mcp__")).map((tool) => tool.replace(/\(.*$/, ""))),
      ].filter((tool) => CLAUDE_TOOLS.includes(tool));
      const signal = this.#current.stop.signal;
      const outcome =
        agent === "codex"
          ? await this.spawner(
              "codex",
              [
                "exec",
                "--sandbox",
                mode === "limited" || mode === "on" ? "workspace-write" : "read-only",
                "-c",
                `openai_base_url=${JSON.stringify(`${base}/openai/v1`)}`,
                prompt,
              ],
              { cwd: checkout, env, signal },
            )
          : await this.spawner(
              "claude",
              [
                "-p",
                prompt,
                "--output-format",
                "json",
                "--tools",
                builtIn.join(","),
                "--allowedTools",
                allowed.join(","),
              ],
              { cwd: checkout, env, signal },
            );
      const cut = this.#current.cut;
      const collector = routine.fields.collector === "yes";
      const result = cut
        ? `Cut off: it called ${cut}, which this machine does not allow it.`
        : collector && outcome.code === 0
          ? "Done: what it gathered is in its person's me space."
          : resultText(outcome.text);
      const cost = (await store.usage.list({ sessionId })).reduce((total, row) => total + (row.cost ?? 0), 0);
      return await this.#finish(
        runId,
        { status: cut ? "cut" : outcome.code === 0 ? "done" : "failed", result, cost, actions: this.#current.actions },
        report,
        task,
      );
    } catch (error) {
      return await this.#finish(
        runId,
        { status: "failed", result: (error as Error).message, cost: 0, actions: 0 },
        report,
        task,
      );
    } finally {
      if (renew) clearInterval(renew);
      this.#current = null;
      await store.sessions.end(sessionId, this.now()).catch(() => undefined);
      if (fresh && root) await git(root, ["worktree", "remove", "--force", checkout]).catch(() => undefined);
      rmSync(folder, { recursive: true, force: true });
      void this.tick();
    }
  }

  /** Changes a task's fields here and sends them to the team store at once. */
  async #setTask(task: FullRecord, change: Record<string, unknown>): Promise<void> {
    const deps = await this.deps.storeDeps();
    const current = (await this.deps.store.records.get(task.id)) ?? task;
    const { seq: _seq, hits: _hits, ...rest } = current as FullRecord;
    await write(
      deps,
      { ...rest, fields: { ...rest.fields, ...change, machine: deps.me.device }, updatedAt: this.now() },
      current as FullRecord,
    );
    await this.deps.sync().catch(() => undefined);
  }

  async #finish(
    runId: string,
    outcome: Omit<RunOutcome, "id">,
    report: (fields: Record<string, unknown>) => Promise<unknown>,
    task: FullRecord | undefined,
  ): Promise<RunOutcome> {
    const endedAt = this.now();
    const result = outcome.result.slice(0, MAX_RESULT);
    await this.deps.store.runs
      .update(runId, { status: outcome.status, endedAt, actions: outcome.actions, result })
      .catch(() => undefined);
    await report({ status: outcome.status, endedAt, actions: outcome.actions, cost: outcome.cost });
    if (task) {
      const deps = await this.deps.storeDeps();
      const current = (await this.deps.store.records.get(task.id)) ?? task;
      const { seq: _seq, hits: _hits, ...rest } = current as FullRecord;
      const done = outcome.status === "done";
      await write(
        deps,
        {
          ...rest,
          fields: { ...rest.fields, status: done ? "done" : "to-do", result, machine: deps.me.device },
          updatedAt: endedAt,
        },
        current as FullRecord,
      );
      // Sent before the decline: the store drops a task's claims when it goes back to to-do, and only this one's.
      await this.deps.sync().catch(() => undefined);
      const team = this.deps.team();
      if (!done && team) {
        await teamApi(team, `/api/work/${encodeURIComponent(task.id)}/decline`, { body: {} }).catch(() => undefined);
      }
    }
    return { id: runId, ...outcome, result };
  }

  /** Scores a version on each eval case: by code here, by a model through a second short run, or by a person. */
  async evaluate(
    routine: FullRecord,
    version: RoutineVersion,
    mode: RoutineMode,
  ): Promise<{ score: number | null; runs: RunOutcome[] }> {
    const cases = evalsOf(routine);
    if (cases.length === 0) throw new Error(`${routine.title} has no eval set yet`);
    const runs: RunOutcome[] = [];
    const scores: number[] = [];
    for (const test of cases) {
      const outcome = await this.run({ routine, version, prompt: test.input, trigger: "eval", mode });
      let score: number | null = null;
      if (outcome.status === "done" && test.judge === "code") score = judgeByCode(outcome.result, test.expect);
      if (outcome.status === "done" && test.judge === "model") score = await this.#judge(outcome.result, test.expect);
      if (outcome.status !== "done") score = 0;
      if (score !== null) scores.push(score);
      const team = this.deps.team();
      if (team && score !== null) {
        await teamApi(team, "/api/runs", {
          body: {
            id: outcome.id,
            routineId: routine.id,
            version: version.version,
            kind: "eval",
            status: outcome.status,
            endedAt: this.now(),
            actions: outcome.actions,
            cost: outcome.cost,
            score,
          },
        }).catch(() => undefined);
      }
      runs.push(outcome);
    }
    return { score: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null, runs };
  }

  async #judge(result: string, expected: string): Promise<number> {
    const prompt = `Does this result do what is asked? Answer with one word, yes or no.\n\nAsked: ${expected}\n\nResult:\n${result.slice(0, 8000)}`;
    const answer = await this.spawner("claude", ["-p", prompt, "--output-format", "json", "--allowedTools", ""], {
      cwd: tmpdir(),
      env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${this.deps.port}` },
    });
    return /\byes\b/i.test(resultText(answer.text)) ? 1 : 0;
  }
}

/** The agent's final answer: Claude Code's JSON `result`, or what it printed. */
export function resultText(output: string): string {
  try {
    const parsed = JSON.parse(output) as { result?: unknown };
    if (typeof parsed.result === "string") return parsed.result;
  } catch {
    // Printed text, as Codex prints it.
  }
  return output.trim();
}
