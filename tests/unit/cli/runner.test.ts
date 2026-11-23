import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, defaultConfig } from "@grenier/core";
import { ensureRepoSpace, type StoreDeps, syncOnce, type TeamClient, teamApi, write } from "@grenier/index";
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

const idle: Probes = {
  pluggedIn: async () => true,
  idleSeconds: async () => 3600,
  load: () => 0.1,
  memory: async () => 0.3,
  hour: () => 12,
};
const config: Config = { ...defaultConfig(), machine: { ...defaultConfig().machine, routines: true } };

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
    log: () => {},
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
    space: "team",
    type: "Task",
    kind: null,
    title,
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
  await store.spaces.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
  await store.state.set("team_member", "ada");
  await store.state.set("team_me_space", "me:ada");
  deps = await storeDeps(store);
  calls = [];
  notices = [];
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
      repo: null,
      space: "team",
    });
    await task("Bump hono", routine.id);
    await newRunner().tick(true);
    expect(calls).toEqual([]);
    expect(notices[0]).toContain("Update dependencies");
    const offer = await teamApi<{ offer: unknown }>(team, "/api/work/claim", { body: {} });
    expect(offer.offer).toBeNull();
  });

  it("runs an approved routine read-only in a clean checkout, and attaches the result to the task", async () => {
    const repo = new TestRepo({ "router.ts": "export function route() {}\n" });
    try {
      await repo.ready();
      await ensureRepoSpace(store, repo.repo);
      const routine = await addRoutine(deps, {
        title: "Update dependencies",
        prompt: "Update the dependencies.",
        fields: { trigger: "request", tools: ["Edit", "Bash(pnpm test:*)"] },
        repo: repo.repo.id,
        space: "team",
      });
      await approve(store, (await store.records.get(routine.id)) as FullRecord, "read-only");
      const id = await task("Bump hono", routine.id);
      await newRunner().tick(true);

      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call?.command).toBe("claude");
      expect(call?.files).toBe(true);
      expect(call?.cwd).not.toBe(repo.dir);
      expect(existsSync(call?.cwd as string)).toBe(false);
      const allowed = call?.args[call.args.indexOf("--allowedTools") + 1] ?? "";
      expect(allowed).toContain("Read");
      expect(allowed).not.toContain("Edit");
      expect(call?.args[call.args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
      expect(call?.args[1]).toContain("Update the dependencies.");
      expect(call?.args[1]).toContain("Bump hono");
      expect(call?.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:7788\/s\//);
      expect(call?.env.GRENIER_RUN_SPACE).toBe("team");

      expect((await store.records.get(id))?.fields).toMatchObject({
        status: "done",
        result: "Bumped hono to 4.12.",
        machine: "ada-mbp",
      });
      const runs = await teamApi<{ runs: { status: string; task_id: string }[] }>(team, "/api/runs");
      expect(runs.runs[0]).toMatchObject({ status: "done", task_id: id });
      expect(readFileSync(join(repo.dir, "router.ts"), "utf8")).toBe("export function route() {}\n");
    } finally {
      repo.remove();
    }
  });

  it("holds a run to its mode: a tool call it may not make cuts it off, and the task goes back", async () => {
    const routine = await addRoutine(deps, {
      title: "Tidy",
      prompt: "Tidy up.",
      fields: { trigger: "request", tools: ["Edit"] },
      repo: null,
      space: "team",
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

  it("counts actions against a limited run's allowance", async () => {
    const routine = await addRoutine(deps, {
      title: "Label issues",
      prompt: "Label them.",
      fields: { trigger: "request", tools: ["mcp__linear__update_issue"] },
      repo: null,
      space: "team",
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
    await newRunner().tick(true);
    expect(seen).toEqual([true, true, false]);
  });

  it("runs the librarian here, which suggests fixes instead of starting an agent", async () => {
    const routine = await addRoutine(deps, {
      title: "Librarian",
      prompt: "Built in.",
      fields: { trigger: "request", builtin: LIBRARIAN },
      repo: null,
      space: "team",
    });
    await approve(store, (await store.records.get(routine.id)) as FullRecord, "read-only");
    for (const [id, updatedAt] of [
      ["old", 1],
      ["new", 2],
    ] as const) {
      await write(deps, {
        id,
        space: "team",
        type: "Doc",
        kind: null,
        title: "How to release",
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
    const suggestions = await store.records.list({ spaces: ["team"], type: "Suggestion" });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.fields).toMatchObject({ target: "old", change: { retire: true } });
  });
});
