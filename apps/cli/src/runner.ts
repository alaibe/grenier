import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setPriority } from "node:os";
import {
  acts,
  type Config,
  hasPrompt,
  isAction,
  mayCall,
  READ_TOOLS,
  type RoutineMode,
  routineHash,
  STORE_TOOLS,
} from "@grenier/core";
import type { Availability } from "@grenier/core/api";
import type { RunGuard } from "@grenier/gateway";
import { newId, refusal, type StoreDeps, type TeamClient, teamApi, write } from "@grenier/index";
import type { FullRecord, RecordInput, Session, Store } from "@grenier/store";
import { LIBRARIAN, librarian } from "./librarian.ts";
import { availability, type Probes, systemProbes } from "./machine.ts";
import { newSessionId, repoResolver } from "./runtime.ts";

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
  now?: () => number;
}

interface Current {
  runId: string;
  sessionId: string;
  routineId: string;
  agent: string;
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
/** Claude Code's built-in tools that only read: `--tools` makes only these available to a run that may not act. */
const CLAUDE_READS = ["Read", "Grep", "Glob"];

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

/** This machine's part in the team's routines: takes the work offered and runs it in its work folder. */
export class Runner {
  #current: Current | null = null;
  #last: Availability | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastClaim = 0;
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
        agents: [this.deps.config().machine.agent],
      });
    }
    if (now.state !== "available" || this.running) return;
    if (force || changed || this.now() - this.#lastClaim >= CLAIM_EVERY) await this.claim();
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
    if (routine.fields.builtin === LIBRARIAN && (await this.deps.store.state.get("team_role")) === "member") {
      return decline("the librarian writes suggestions for the team: an admin's machine runs it");
    }
    if (!hasPrompt(routine)) return decline("it says nothing to do yet");
    await this.run({
      routine,
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
        if (!mayCall(current.agent, current.mode, tool)) return false;
        if (isAction(tool, current.agent)) {
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

  /** One run of a routine, as its text says now: for a task, or by hand. */
  async run(input: {
    routine: FullRecord;
    task?: FullRecord;
    /** By hand: what to do this time, in place of a task. */
    prompt?: string;
    trigger: "request" | "manual";
    mode: RoutineMode;
  }): Promise<RunOutcome> {
    if (this.#current) throw new Error("a run is going on this machine already");
    const { routine, task, mode } = input;
    const store = this.deps.store;
    const config = this.deps.config();
    const agent = typeof routine.fields.agent === "string" ? routine.fields.agent : config.machine.agent;
    const cwd = config.machine.workdir;
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
      sessionId,
      trigger: input.trigger,
      status: "running",
      startedAt,
      endedAt: null,
      actions: 0,
      result: null,
    });
    if (!cwd || !existsSync(cwd)) {
      return this.#finish(
        runId,
        { status: "failed", result: "this machine has no work folder: set it in Settings", cost: 0, actions: 0 },
        report,
        task,
      );
    }
    const midnight = new Date(startedAt).setHours(0, 0, 0, 0);
    const usedToday = (await store.runs.list({ routineId: routine.id, since: midnight })).reduce(
      (total, run) => total + run.actions,
      0,
    );
    this.#current = {
      runId,
      sessionId,
      routineId: routine.id,
      agent,
      mode,
      limit: Number((await store.approvals.get(routine.id, "routine"))?.settings.limit ?? 10),
      usedToday,
      actions: 0,
      cut: null,
      stop: new AbortController(),
    };
    let renew: ReturnType<typeof setInterval> | undefined;
    try {
      const repo = await repoResolver(cwd)(undefined).catch(() => null);
      await store.sessions.create({
        id: sessionId,
        client: agent,
        cwd,
        repoRoot: repo?.root ?? null,
        repoId: repo?.id ?? null,
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
        routine.body,
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
        GRENIER_RUN_TOP: routine.fields.collector === "yes" ? "me" : routine.top === "me" ? "me" : "team",
      };
      // Acting, Claude Code's auto mode judges each call; reading, it gets the reading tools alone.
      const claudeMode = acts(mode)
        ? ["--permission-mode", "auto", "--allowedTools", STORE_TOOLS.join(",")]
        : ["--tools", CLAUDE_READS.join(","), "--allowedTools", [...READ_TOOLS, ...STORE_TOOLS].join(",")];
      const signal = this.#current.stop.signal;
      const outcome =
        agent === "codex"
          ? await this.spawner(
              "codex",
              [
                "exec",
                "--sandbox",
                acts(mode) ? "workspace-write" : "read-only",
                "-c",
                `openai_base_url=${JSON.stringify(`${base}/openai/v1`)}`,
                prompt,
              ],
              { cwd, env, signal },
            )
          : await this.spawner("claude", ["-p", prompt, "--output-format", "json", ...claudeMode], {
              cwd,
              env,
              signal,
            });
      const cut = this.#current.cut;
      const collector = routine.fields.collector === "yes";
      const result = cut
        ? `Cut off: it called ${cut}, which this machine does not allow it.`
        : collector && outcome.code === 0
          ? "Done: what it gathered is in its person's Me folder."
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
      const ended = (text: string): RecordInput => ({
        ...rest,
        fields: { ...rest.fields, status: done ? "done" : "to-do", result: text, machine: deps.me.device },
        updatedAt: endedAt,
      });
      // A result the team store would refuse must not hold the task in "doing": a short failure takes its place.
      const why = await refusal(deps.store, ended(result), current as FullRecord);
      await write(deps, ended(why ? `Its result was not kept: ${why}.` : result), current as FullRecord);
      // Sent before the decline: the store drops a task's claims when it goes back to to-do, and only this one's.
      await this.deps.sync().catch(() => undefined);
      const team = this.deps.team();
      if (!done && team) {
        await teamApi(team, `/api/work/${encodeURIComponent(task.id)}/decline`, { body: {} }).catch(() => undefined);
      }
    }
    return { id: runId, ...outcome, result };
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
