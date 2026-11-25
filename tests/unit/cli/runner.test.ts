import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, defaultConfig } from "@grenier/core";
import { type StoreDeps, syncOnce, type TeamClient, teamApi, write } from "@grenier/index";
import type { FullRecord, Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIBRARIAN } from "../../../apps/cli/src/librarian.ts";
import type { Probes } from "../../../apps/cli/src/machine.ts";
import { addRoutine, approve } from "../../../apps/cli/src/routines.ts";
import { Runner, type Spawner } from "../../../apps/cli/src/runner.ts";
import { storeDeps, TestRepo } from "../../support/repo.ts";
import { SETUP_TOKEN, startWorker } from "../../support/worker.ts";

let mf: Miniflare;
let team: TeamClient;
let store: Store;
let deps: StoreDeps;
let calls: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  files: boolean;
  signal: AbortSignal | undefined;
}[];
let answer: (runner: Runner, args: string[]) => Promise<{ code: number; text: string }>;
let notices: string[];
let logs: string[];

const idle: Probes = {
  pluggedIn: async () => true,
  idleSeconds: async () => 3600,
  load: () => 0.1,
  memory: async () => 0.3,
  hour: () => 12,
};
const config: Config = {
  ...defaultConfig(),
  machine: { ...defaultConfig().machine, routines: true, workdir: tmpdir() },
};

function newRunner(): Runner {
  const runner: Runner = new Runner({
    store,
    config: () => config,
    port: 7788,
    team: () => team,
    storeDeps: async () => deps,
    tell: async (state) => {
      await teamApi(team, "/api/machines/me", { method: "PUT", body: state });
    },
    sync: async () => {
      await syncOnce({ store, team, embedder: null, personalKey: null });
    },
    log: (line) => logs.push(line),
    notify: (title, message) => notices.push(`${title}: ${message}`),
    probes: idle,
    spawner: (async (command, args, options) => {
      calls.push({
        command,
        args,
        cwd: options.cwd,
        env: options.env,
        files: existsSync(join(options.cwd, "router.ts")),
        signal: options.signal,
      });
      return answer(runner, args);
    }) as Spawner,
  });
  return runner;
}

async function task(title: string, routine: string): Promise<string> {
  const id = `task-${title.replace(/\W+/g, "-")}`;
  await write(deps, {
    id,
    top: "team",
    type: "Task",
    kind: null,
    title,
    folder: "",
    body: "",
    fields: { status: "to-do", routine },
    author: "ada",
    device: "ada-mbp",
    sessionId: null,
    createdAt: 1,
    updatedAt: 1,
    retiredAt: null,
    version: 0,
    anchors: [],
    links: [],
  });
  await syncOnce({ store, team, embedder: null, personalKey: null });
  return id;
}

beforeEach(async () => {
  let workerFetch: typeof fetch;
  ({ mf, fetch: workerFetch } = await startWorker());
  await workerFetch("https://team.test/api/setup", {
    method: "POST",
    headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ member: "ada", device: "ada-mbp" }),
  });
  team = { url: "https://team.test", token: SETUP_TOKEN, fetch: workerFetch };
  store = openSqliteStore(":memory:");
  await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
  await store.state.set("team_member", "ada");
  await store.state.set("team_me_top", "me:ada");
  deps = await storeDeps(store);
  calls = [];
  notices = [];
  logs = [];
  answer = async () => ({ code: 0, text: JSON.stringify({ result: "Bumped hono to 4.12." }) });
}, 60_000);

afterEach(async () => {
  await store.close();
  await mf.dispose();
});

describe("a machine that takes the team's routine runs", () => {
  it("declines a request for a routine its person has not approved, and tells them", async () => {
    const routine = await addRoutine(deps, {
      title: "Update dependencies",
      prompt: "Update the dependencies.",
      fields: { trigger: "request" },
      top: "team",
    });
    await task("Bump hono", routine.id);
    await newRunner().tick(true);
    expect(calls).toEqual([]);
    expect(notices[0]).toContain("Update dependencies");
    const offer = await teamApi<{ offer: unknown }>(team, "/api/work/claim", { body: {} });
    expect(offer.offer).toBeNull();
  });

  it("runs an approved routine read-only in the work folder, and attaches the result to the task", async () => {
    const repo = new TestRepo({ "router.ts": "export function route() {}\n" });
    try {
      await repo.ready();
      config.machine.workdir = repo.dir;
      const routine = await addRoutine(deps, {
        title: "Update dependencies",
        prompt: "Update the dependencies.",
        fields: { trigger: "request" },
        top: "team",
      });
      await approve(store, (await store.records.get(routine.id)) as FullRecord, "read-only");
      const id = await task("Bump hono", routine.id);
      await newRunner().tick(true);

      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call?.command).toBe("claude");
      expect(call?.files).toBe(true);
      expect(call?.cwd).toBe(repo.dir);
      expect(call?.args).not.toContain("--permission-mode");
      const allowed = call?.args[call.args.indexOf("--allowedTools") + 1] ?? "";
      expect(allowed).toContain("Read");
      expect(allowed).not.toContain("Edit");
      expect(call?.args[call.args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
      expect(call?.args[1]).toContain("Update the dependencies.");
      expect(call?.args[1]).toContain("Bump hono");
      expect(call?.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:7788\/s\//);
      expect(call?.env.GRENIER_RUN_TOP).toBe("team");

      expect((await store.records.get(id))?.fields).toMatchObject({
        status: "done",
        result: "Bumped hono to 4.12.",
        machine: "ada-mbp",
      });
      const runs = await teamApi<{ runs: { status: string; task_id: string }[] }>(team, "/api/runs");
      expect(runs.runs[0]).toMatchObject({ status: "done", task_id: id });
      expect(readFileSync(join(repo.dir, "router.ts"), "utf8")).toBe("export function route() {}\n");
    } finally {
      config.machine.workdir = tmpdir();
      repo.remove();
    }
  });

  it("holds a run to its mode: a tool call it may not make cuts it off, and the task goes back", async () => {
    const routine = await addRoutine(deps, {
      title: "Tidy",
      prompt: "Tidy up.",
      fields: { trigger: "request" },
      top: "team",
    });
    await approve(store, (await store.records.get(routine.id)) as FullRecord, "read-only");
    const id = await task("Tidy the readme", routine.id);
    answer = async (runner) => {
      const running = await store.runs.list({ routineId: routine.id });
      const current = await store.sessions.get(running[0]?.sessionId as string);
      const guard = runner.guard(current as never);
      expect(guard?.allows("Read")).toBe(true);
      expect(guard?.allows("Edit")).toBe(false);
      guard?.cut("Edit");
      expect(calls.at(-1)?.signal?.aborted).toBe(true);
      return { code: 130, text: "stopped" };
    };
    await newRunner().tick(true);
    const record = await store.records.get(id);
    expect(record?.fields.status).toBe("to-do");
    expect(String(record?.fields.result)).toContain("Cut off: it called Edit");
    expect((await store.runs.list({ routineId: routine.id }))[0]?.status).toBe("cut");
  });

  it("holds a read-only Codex run to its sandbox, and its patch tool to the mode", async () => {
    const routine = await addRoutine(deps, {
      title: "Explain",
      prompt: "Explain the router.",
      fields: { trigger: "request", agent: "codex" },
      top: "team",
    });
    const record = (await store.records.get(routine.id)) as FullRecord;
    const seen: Record<string, boolean> = {};
    answer = async (runner) => {
      const running = await store.runs.list({ routineId: routine.id });
      const guard = runner.guard((await store.sessions.get(running[0]?.sessionId as string)) as never);
      for (const tool of ["exec_command", "mcp__grenier__recall", "apply_patch", "mcp__linear__update_issue"]) {
        seen[tool] = guard?.allows(tool) ?? false;
      }
      return { code: 0, text: "The router is in router.ts." };
    };
    const runner = newRunner();
    // Told and asked already: the tick after the run has nothing to send while the test ends.
    await runner.tick(true);
    await runner.run({ routine: record, trigger: "manual", mode: "read-only" });
    expect(calls[0]?.command).toBe("codex");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
    expect(seen).toEqual({
      exec_command: true,
      mcp__grenier__recall: true,
      apply_patch: false,
      mcp__linear__update_issue: false,
    });
    expect((await store.runs.list({ routineId: routine.id }))[0]?.actions).toBe(0);
  });

  it("counts a limited Codex run's patches against its allowance, not the shell it reads with", async () => {
    const routine = await addRoutine(deps, {
      title: "Fix typos",
      prompt: "Fix the typos.",
      fields: { trigger: "request", agent: "codex" },
      top: "team",
    });
    await approve(store, (await store.records.get(routine.id)) as FullRecord, "limited", 2);
    const seen: boolean[] = [];
    answer = async (runner) => {
      const running = await store.runs.list({ routineId: routine.id });
      const guard = runner.guard((await store.sessions.get(running[0]?.sessionId as string)) as never);
      for (let n = 0; n < 12; n++) seen.push(guard?.allows("exec_command") ?? false);
      for (let n = 0; n < 3; n++) seen.push(guard?.allows("apply_patch") ?? false);
      return { code: 0, text: "Fixed two." };
    };
    const runner = newRunner();
    await runner.tick(true);
    await runner.run({
      routine: (await store.records.get(routine.id)) as FullRecord,
      trigger: "manual",
      mode: "limited",
    });
    expect(seen).toEqual([...Array(12).fill(true), true, true, false]);
    expect((await store.runs.list({ routineId: routine.id }))[0]?.actions).toBe(2);
  });

  it("counts actions against a limited run's allowance", async () => {
    const routine = await addRoutine(deps, {
      title: "Label issues",
      prompt: "Label them.",
      fields: { trigger: "request" },
      top: "team",
    });
    await approve(store, (await store.records.get(routine.id)) as FullRecord, "limited", 2);
    await task("Label this week's", routine.id);
    const seen: boolean[] = [];
    answer = async (runner) => {
      const running = await store.runs.list({ routineId: routine.id });
      const guard = runner.guard((await store.sessions.get(running[0]?.sessionId as string)) as never);
      for (let n = 0; n < 3; n++) seen.push(guard?.allows("mcp__linear__update_issue") ?? false);
      return { code: 0, text: JSON.stringify({ result: "Labelled two." }) };
    };
    const runner = newRunner();
    await runner.tick(true);
    expect(seen).toEqual([true, true, false]);
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(args).not.toContain("--tools");

    seen.length = 0;
    const record = (await store.records.get(routine.id)) as FullRecord;
    await runner.run({ routine: record, trigger: "manual", mode: "limited" });
    expect(seen).toEqual([false, false, false]);
  });

  it("ends the task with a short failure when the team store would refuse its result", async () => {
    const routine = await addRoutine(deps, {
      title: "Deploy",
      prompt: "Deploy.",
      fields: { trigger: "request" },
      top: "team",
    });
    await approve(store, (await store.records.get(routine.id)) as FullRecord, "read-only");
    const id = await task("Deploy the site", routine.id);
    answer = async () => ({ code: 0, text: JSON.stringify({ result: "Deployed with AKIAABCDEFGHIJKLMNOP." }) });
    await newRunner().tick(true);
    const fields = (await store.records.get(id))?.fields;
    expect(fields?.status).toBe("done");
    expect(fields?.result).toBe("Its result was not kept: it holds what looks like a key or a token.");
    const remote = await teamApi<{ records: FullRecord[] }>(team, "/api/changes?after=0&limit=500");
    expect(remote.records.find((record) => record.id === id)?.fields.status).toBe("done");
  });

  it("lists a run on a machine with no work folder, as failed", async () => {
    const routine = await addRoutine(deps, {
      title: "Elsewhere",
      prompt: "Do it.",
      fields: { trigger: "request" },
      top: "team",
    });
    const record = (await store.records.get(routine.id)) as FullRecord;
    const runner = newRunner();
    // Told and asked already: the tick after the run has nothing to send while the test ends.
    await runner.tick(true);
    config.machine.workdir = "";
    try {
      await runner.run({ routine: record, trigger: "manual", mode: "read-only" });
    } finally {
      config.machine.workdir = tmpdir();
    }
    const [run] = await store.runs.list({ routineId: routine.id });
    expect(run).toMatchObject({ status: "failed", result: "this machine has no work folder: set it in Settings" });
    expect(calls).toEqual([]);
  });

  it("leaves the librarian to an admin's machine: it writes for the team", async () => {
    const routine = await addRoutine(deps, {
      title: "Librarian",
      prompt: "Built in.",
      fields: { trigger: "request", builtin: LIBRARIAN },
      top: "team",
    });
    await approve(store, (await store.records.get(routine.id)) as FullRecord, "read-only");
    await task("Look through the store", routine.id);
    await store.state.set("team_role", "member");
    await newRunner().tick(true);
    expect(logs).toContainEqual(expect.stringContaining("an admin's machine runs it"));
    expect(await store.records.list({ tops: ["team"], type: "Suggestion" })).toEqual([]);
  });

  it("runs the librarian on an admin's machine, which suggests fixes instead of starting an agent", async () => {
    const routine = await addRoutine(deps, {
      title: "Librarian",
      prompt: "Built in.",
      fields: { trigger: "request", builtin: LIBRARIAN },
      top: "team",
    });
    await approve(store, (await store.records.get(routine.id)) as FullRecord, "read-only");
    for (const [id, updatedAt] of [
      ["old", 1],
      ["new", 2],
    ] as const) {
      await write(deps, {
        id,
        top: "team",
        type: "Doc",
        kind: null,
        title: "How to release",
        folder: "",
        body: "",
        fields: {},
        author: "ada",
        device: "ada-mbp",
        sessionId: null,
        createdAt: updatedAt,
        updatedAt,
        retiredAt: null,
        version: 0,
        anchors: [],
        links: [],
      });
    }
    await task("Look through the store", routine.id);
    await newRunner().tick(true);
    expect(calls).toEqual([]);
    const suggestions = await store.records.list({ tops: ["team"], type: "Suggestion" });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.fields).toMatchObject({ target: "old", change: { retire: true } });
  });
});
