import { LoopWatch, toolCalls } from "@grenier/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { fakeUpstream, fixture, messagesRequest, sse, type TestGateway, testGateway } from "../../support/gateway.ts";

const STREAM = fixture("stream-tool-use.sse");

let gateway: TestGateway;

afterEach(async () => {
  await gateway.store.close();
});

async function send(path: string, body: unknown = { model: "claude-opus-5-5" }) {
  const response = await gateway.request(path, messagesRequest(body));
  return { status: response.status, headers: response.headers, text: await response.text() };
}

describe("budgets", () => {
  async function spend(sessionId: string, cost: number, repoId: string | null = null) {
    await gateway.store.sessions.create({
      id: sessionId,
      startedAt: gateway.clock.now,
      repoId,
      repoRoot: repoId ? `/work/${repoId}` : null,
    });
    await gateway.store.usage.add({ sessionId, ts: gateway.clock.now, model: "claude-opus-5-5", cost });
  }

  it("answers 429 with x-should-retry false before any upstream call once the daily budget is reached", async () => {
    const upstream = fakeUpstream(() => sse(STREAM));
    gateway = testGateway(upstream, (config) => {
      config.budgets.daily = 1;
    });
    await spend("earlier", 1.25);

    const response = await send("/s/s1/v1/messages");

    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(JSON.parse(response.text)).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message:
          "Grenier stopped this request: the daily budget of $1.00 is reached ($1.25 spent). To change it, run: grenier budget set --daily <amount>",
      },
    });
    expect(upstream.requests).toEqual([]);
    expect(await gateway.store.events.list({ kind: "budget" })).toHaveLength(1);
  });

  it("counts only today's spending against the daily budget", async () => {
    const upstream = fakeUpstream(() => sse(STREAM));
    gateway = testGateway(upstream, (config) => {
      config.budgets.daily = 1;
    });
    const yesterday = gateway.clock.now - 86_400_000;
    await gateway.store.usage.add({ sessionId: "old", ts: yesterday, model: "m", cost: 5 });

    expect((await send("/s/s1/v1/messages")).status).toBe(200);
  });

  it("stops one session at its own budget and lets another through", async () => {
    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      (config) => {
        config.budgets.session = 0.5;
      },
    );
    await spend("s1", 0.5);

    expect((await send("/s/s1/v1/messages")).text).toContain("this session's budget of $0.50 is reached");
    expect((await send("/s/s2/v1/messages")).status).toBe(200);
  });

  it("applies a project's budget to its sessions only", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    await gateway.store.budgets.set("repo", "app", 2);
    await spend("s1", 2, "app");
    await gateway.store.sessions.create({ id: "s2", startedAt: 0, repoId: "app", repoRoot: "/work/app" });
    await gateway.store.sessions.create({ id: "s3", startedAt: 0, repoId: "api", repoRoot: "/work/api" });

    expect((await send("/s/s2/v1/messages")).text).toContain("grenier budget set --repo app=<amount>");
    expect((await send("/s/s3/v1/messages")).status).toBe(200);
  });

  it("counts a project by its folder name, in a repository or not", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    await gateway.store.budgets.set("repo", "app", 2);
    await gateway.store.budgets.set("repo", "notes", 1);
    await spend("s1", 1, "app");
    await gateway.store.sessions.create({ id: "elsewhere", startedAt: 0, repoId: "other", repoRoot: "/home/old/app" });
    await gateway.store.usage.add({ sessionId: "elsewhere", ts: gateway.clock.now, model: "claude-opus-5-5", cost: 1 });
    await gateway.store.sessions.create({ id: "worktree", startedAt: 0, repoId: "app", repoRoot: "/work/app-fix" });
    await gateway.store.sessions.create({ id: "s1-too", startedAt: 0, repoId: "app", repoRoot: "/work/app" });
    await gateway.store.sessions.create({ id: "folder", startedAt: 0, cwd: "/home/notes" });
    await gateway.store.usage.add({ sessionId: "folder", ts: gateway.clock.now, model: "claude-opus-5-5", cost: 1 });

    expect((await send("/s/s1-too/v1/messages")).text).toContain("grenier budget set --repo app=<amount>");
    expect((await send("/s/worktree/v1/messages")).status).toBe(200);
    expect((await send("/s/folder/v1/messages")).text).toContain("grenier budget set --repo notes=<amount>");
  });

  it("takes a limit set while running into account at the next request, without a restart", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    await spend("s1", 3);
    expect((await send("/s/s1/v1/messages")).status).toBe(200);

    await gateway.store.budgets.set("daily", "", 2);
    expect((await send("/s/s1/v1/messages")).status).toBe(429);

    await gateway.store.budgets.set("daily", "", 50);
    expect((await send("/s/s1/v1/messages")).status).toBe(200);
  });

  it("stops a request that would pass the limit if it cost what the session's last one did", async () => {
    const upstream = fakeUpstream(() => sse(STREAM));
    gateway = testGateway(upstream, (config) => {
      config.budgets.daily = 10;
    });
    await spend("s1", 9);
    await gateway.store.usage.add({ sessionId: "s1", ts: gateway.clock.now, model: "claude-opus-5-5", cost: 0.6 });

    const response = await send("/s/s1/v1/messages");
    expect(response.status).toBe(429);
    expect(JSON.parse(response.text).error.message).toBe(
      "Grenier stopped this request: the daily budget of $10.00 would be passed ($9.60 spent, and this session's last request cost $0.60). To change it, run: grenier budget set --daily <amount>",
    );
    expect(upstream.requests).toEqual([]);
    expect((await send("/s/s2/v1/messages")).status).toBe(200);
  });

  it("counts requests still in flight against a limit", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    gateway = testGateway(
      fakeUpstream(async () => {
        calls += 1;
        if (calls > 1) await gate;
        return sse(STREAM);
      }),
      (config) => {
        config.budgets.session = 0.05;
      },
    );
    expect((await send("/s/s1/v1/messages")).status).toBe(200);

    const pending = Array.from({ length: 5 }, () => send("/s/s1/v1/messages"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const statuses = (await Promise.all(pending)).map((response) => response.status);

    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(await gateway.store.usage.spend({ sessionId: "s1" })).toBeLessThanOrEqual(0.05);
  });

  it("stops a request to a model with no price while a limit applies, unless told to allow it", async () => {
    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      (config) => {
        config.budgets.daily = 10;
      },
    );
    const refused = await send("/s/s1/v1/messages", { model: "mystery-model" });
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.text).error.message).toContain("mystery-model has no price");
    expect((await send("/s/s1/v1/messages", { model: "claude-opus-5-5-20260101" })).status).toBe(200);
    await gateway.store.close();

    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      (config) => {
        config.budgets.daily = 10;
        config.budgets.unpriced = "allow";
      },
    );
    expect((await send("/s/s1/v1/messages", { model: "mystery-model" })).status).toBe(200);
    expect((await send("/s/s1/v1/messages", { model: "mystery-model" })).status).toBe(200);
    expect(gateway.notifications.filter((line) => line.includes("mystery-model"))).toHaveLength(1);
  });

  it("lets a model with no price through when no limit applies, and says once that it counts as $0", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    expect((await send("/s/s1/v1/messages", { model: "mystery-model" })).status).toBe(200);
    expect((await send("/s/s2/v1/messages", { model: "mystery-model" })).status).toBe(200);
    expect(gateway.notifications.filter((line) => line.includes("mystery-model"))).toHaveLength(1);
    expect(await gateway.store.events.list({ kind: "unpriced" })).toHaveLength(1);
  });

  it("warns once when today's spending passes 80% of a limit", async () => {
    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      (config) => {
        config.budgets.daily = 1;
      },
    );
    await spend("earlier", 0.85);

    expect((await send("/s/s1/v1/messages")).status).toBe(200);
    expect((await send("/s/s1/v1/messages")).status).toBe(200);

    expect(gateway.notifications.filter((line) => line.includes("80%"))).toEqual([
      "Grenier: 80% of a budget: $0.85 of the daily budget of $1.00 is spent.",
    ]);
    expect(await gateway.store.events.list({ kind: "budget_warning" })).toHaveLength(1);
  });

  it("writes small amounts with the digits that matter", async () => {
    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      (config) => {
        config.budgets.daily = 0.004;
      },
    );
    await spend("earlier", 0.0049);
    expect(JSON.parse((await send("/s/s1/v1/messages")).text).error.message).toContain(
      "the daily budget of $0.004 is reached ($0.0049 spent)",
    );
  });

  it("does not hold back requests other than inference", async () => {
    const upstream = fakeUpstream(() => Response.json({ input_tokens: 10 }));
    gateway = testGateway(upstream, (config) => {
      config.budgets.daily = 1;
    });
    await spend("s0", 5);
    expect((await send("/s/s1/v1/messages/count_tokens")).status).toBe(200);
  });
});

describe("loops", () => {
  const toolUse = (id: string, input: unknown, name = "Bash") => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  });
  const toolResult = (id: string, content: string, isError = false) => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
  });

  /** One request per turn, each resending the whole conversation, as an agent does. */
  async function conversation(path: string, turns: unknown[][]) {
    const messages: unknown[] = [{ role: "user", content: "fix the tests" }];
    const statuses: number[] = [];
    await send(path, { model: "claude-opus-5-5", messages });
    for (const turn of turns) {
      messages.push(...turn);
      statuses.push((await send(path, { model: "claude-opus-5-5", messages })).status);
    }
    return statuses;
  }

  it("raises one loop event when the same tool call comes three times, and notifies", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    const same = { command: "npm test", timeout: 60 };
    const reordered = { timeout: 60, command: "npm test" };

    await conversation("/s/s1/v1/messages", [
      [toolUse("t1", same), toolResult("t1", "1 failing")],
      [toolUse("t2", { command: "ls" }), toolResult("t2", "src")],
      [toolUse("t3", reordered), toolResult("t3", "1 failing")],
      [toolUse("t4", same), toolResult("t4", "1 failing")],
      [toolUse("t5", same), toolResult("t5", "1 failing")],
    ]);

    const events = await gateway.store.events.list({ kind: "loop" });
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.detail ?? "{}")).toMatchObject({
      tool: "Bash",
      threshold: 3,
      window: 10,
      action: "notify",
    });
    expect(gateway.notifications).toEqual([
      "Grenier: possible loop: The same Bash call came 3 times in the last 10 tool calls (session s1).",
    ]);
  });

  it("counts the same failing tool result as a loop too", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    await conversation("/s/s1/v1/messages", [
      [toolUse("a", { path: "x" }, "Read"), toolResult("a", "ENOENT: no such file", true)],
      [toolUse("b", { path: "y" }, "Read"), toolResult("b", "ENOENT: no such file", true)],
      [toolUse("c", { path: "z" }, "Read"), toolResult("c", "ENOENT: no such file", true)],
    ]);
    const [event] = await gateway.store.events.list({ kind: "loop" });
    expect(JSON.parse(event?.detail ?? "{}").tool).toBe("error");
  });

  it("tells errors at other lines apart, and keeps a conversation whose cache marker moved", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    const test = { command: "pnpm tsc" };
    const first = (marked: boolean) => ({
      role: "user",
      content: [{ type: "text", text: "fix the types", ...(marked ? { cache_control: { type: "ephemeral" } } : {}) }],
    });
    const turns = [
      [toolUse("b1", test), toolResult("b1", "src/a.ts:12:5 error")],
      [toolUse("b2", test), toolResult("b2", "src/a.ts:40:9 error")],
      [toolUse("b3", test), toolResult("b3", "src/a.ts:77:2 error")],
    ];
    const messages: unknown[] = [];
    for (const [index, turn] of turns.entries()) {
      messages.push(...turn);
      await send("/s/s1/v1/messages", { model: "claude-opus-5-5", messages: [first(index % 2 === 0), ...messages] });
    }
    expect(await gateway.store.events.list({ kind: "loop" })).toEqual([]);

    const same = [
      [toolUse("c1", test), toolResult("c1", "src/a.ts:12:5 error")],
      [toolUse("c2", test), toolResult("c2", "src/a.ts:12:5 error")],
    ];
    for (const [index, turn] of same.entries()) {
      messages.push(...turn);
      await send("/s/s1/v1/messages", { model: "claude-opus-5-5", messages: [first(index % 2 === 1), ...messages] });
    }
    expect(await gateway.store.events.list({ kind: "loop" })).toHaveLength(1);
  });

  it("does not count a call run again while its result changes, as in an edit and test cycle", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    const test = { command: "pnpm test" };
    await conversation("/s/s1/v1/messages", [
      [toolUse("e1", { file_path: "a.ts", new_string: "1" }, "Edit"), toolResult("e1", "ok")],
      [toolUse("b1", test), toolResult("b1", "3 failing")],
      [toolUse("e2", { file_path: "a.ts", new_string: "2" }, "Edit"), toolResult("e2", "ok")],
      [toolUse("b2", test), toolResult("b2", "1 failing")],
      [toolUse("e3", { file_path: "a.ts", new_string: "3" }, "Edit"), toolResult("e3", "ok")],
      [toolUse("b3", test), toolResult("b3", "all pass")],
    ]);
    expect(await gateway.store.events.list({ kind: "loop" })).toEqual([]);
  });

  it("counts a call whose result differs only in its timings", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    const test = { command: "pnpm test" };
    await conversation("/s/s1/v1/messages", [
      [toolUse("b1", test), toolResult("b1", "1 failing\nDuration 1.03s (start at 14:02:11)")],
      [toolUse("b2", test), toolResult("b2", "1 failing\nDuration 980ms (start at 14:02:40)")],
      [toolUse("b3", test), toolResult("b3", "1 failing\nDuration 1.2 s (start at 14:03:05)")],
    ]);
    expect(await gateway.store.events.list({ kind: "loop" })).toHaveLength(1);
  });

  it("watches each conversation of a session apart, as parallel subagents", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    const read = (id: string) => [toolUse(id, { file_path: "README.md" }, "Read"), toolResult(id, "# Demo")];
    for (const [task, id] of [
      ["find the budgets", "a1"],
      ["find the loops", "b1"],
      ["find the cache", "c1"],
    ] as const) {
      await send("/s/s1/v1/messages", {
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: task }, ...read(id)],
      });
    }
    expect(await gateway.store.events.list({ kind: "loop" })).toEqual([]);
  });

  it("only notifies for a loop in untagged requests, since pausing them would hold every client", async () => {
    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      (config) => {
        config.guards.on_loop = "pause";
      },
    );
    const statuses = await conversation("/v1/messages", [
      [toolUse("t1", { command: "x" }), toolResult("t1", "same")],
      [toolUse("t2", { command: "x" }), toolResult("t2", "same")],
      [toolUse("t3", { command: "x" }), toolResult("t3", "same")],
    ]);
    expect(statuses).toEqual([200, 200, 200]);
    expect((await gateway.store.sessions.get("untagged"))?.paused).toBe(false);
    expect(gateway.notifications[0]).toContain("possible loop");
  });

  it("does not count calls that differ", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    await conversation("/s/s1/v1/messages", [
      [toolUse("t1", { command: "a" })],
      [toolUse("t2", { command: "b" })],
      [toolUse("t3", { command: "c" })],
    ]);
    expect(await gateway.store.events.list({ kind: "loop" })).toEqual([]);
  });

  it("does not count again the history of a session that started before the daemon", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    await gateway.store.sessions.create({ id: "old", startedAt: -1 });
    const history = ["t1", "t2", "t3"].flatMap((id) => [toolUse(id, { command: "x" }), toolResult(id, "same")]);
    await send("/s/old/v1/messages", { messages: [{ role: "user", content: "go" }, ...history] });
    expect(await gateway.store.events.list({ kind: "loop" })).toEqual([]);
  });

  it("holds the session's requests when on_loop is pause, until grenier resume", async () => {
    const upstream = fakeUpstream(() => sse(STREAM));
    gateway = testGateway(upstream, (config) => {
      config.guards.on_loop = "pause";
    });
    const turns = ["t1", "t2"].map((id) => [toolUse(id, { command: "x" }), toolResult(id, "same")]);
    await conversation("/s/s1/v1/messages", turns);
    const before = upstream.requests.length;

    const messages = [
      { role: "user", content: "go" },
      ...turns.flat(),
      toolUse("t3", { command: "x" }),
      toolResult("t3", "same"),
    ];
    let settled = false;
    const held = send("/s/s1/v1/messages", { messages }).then((response) => {
      settled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect((await gateway.store.sessions.get("s1"))?.paused).toBe(true);
    expect(upstream.requests.length).toBe(before);
    expect(gateway.notifications[0]).toContain("Run: grenier resume s1");

    await gateway.store.sessions.setPaused("s1", false);
    expect((await held).status).toBe(200);
    expect(upstream.requests.length).toBe(before + 1);
    expect((await gateway.store.events.list({ kind: "pause" })).length).toBe(1);

    const more = ["t4", "t5", "t6"].flatMap((id) => [toolUse(id, { command: "x" }), toolResult(id, "same")]);
    messages.push(...more.slice(0, 4));
    expect((await send("/s/s1/v1/messages", { messages })).status).toBe(200);
    messages.push(...more.slice(4));
    void send("/s/s1/v1/messages", { messages });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await gateway.store.sessions.get("s1"))?.paused).toBe(true);
    expect((await gateway.store.events.list({ kind: "pause" })).length).toBe(2);
    await gateway.store.sessions.setPaused("s1", false);
  });

  it("answers a held request with an error once the pause outlasts its timeout", async () => {
    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      (config) => {
        config.guards.pause_timeout = 1;
      },
    );
    await gateway.store.sessions.create({ id: "s1", startedAt: 0, paused: true });
    const pending = send("/s/s1/v1/messages");
    await new Promise((resolve) => setTimeout(resolve, 20));
    gateway.clock.now += 1_000;

    const response = await pending;
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(JSON.parse(response.text).error.message).toContain("grenier resume s1");
  });
});

describe("team budgets", () => {
  const status = (team: number | null, teamSpent: number, member: number | null = null, memberSpent = 0) => ({
    team: { limit: team, spent: teamSpent },
    member: { limit: member, spent: memberSpent },
  });

  it("stops a request once the team's daily budget is reached, naming who can change it", async () => {
    const upstream = fakeUpstream(() => sse(STREAM));
    gateway = testGateway(upstream, () => {}, { teamBudget: async () => status(5, 5.5) });
    const response = await send("/s/s1/v1/messages");
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(JSON.parse(response.text).error.message).toBe(
      "Grenier stopped this request: the team's daily budget of $5.00 is reached ($5.50 spent). To change it, run: grenier team budget --team <amount> (a team admin)",
    );
    expect(upstream.requests).toEqual([]);
  });

  it("stops a member at their own limit", async () => {
    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      () => {},
      { teamBudget: async () => status(null, 0, 1, 1) },
    );
    expect((await send("/s/s1/v1/messages")).text).toContain("your daily budget of $1.00 in the team");
  });

  it("lets requests through when the team server cannot be reached, and asks it at most every 15 seconds", async () => {
    let asked = 0;
    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      () => {},
      {
        teamBudget: async () => {
          asked += 1;
          throw new Error("offline");
        },
      },
    );
    expect((await send("/s/s1/v1/messages")).status).toBe(200);
    expect((await send("/s/s1/v1/messages")).status).toBe(200);
    expect(asked).toBe(1);
    gateway.clock.now += 16_000;
    await send("/s/s1/v1/messages");
    expect(asked).toBe(2);
  });

  it("stops a request that would pass the team's limit at the session's last cost", async () => {
    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      () => {},
      { teamBudget: async () => status(5, 4.5) },
    );
    await gateway.store.usage.add({ sessionId: "s1", ts: gateway.clock.now, model: "m", cost: 0.75 });
    expect((await send("/s/s1/v1/messages")).text).toContain("the team's daily budget of $5.00 would be passed");
    expect((await send("/s/s2/v1/messages")).status).toBe(200);
  });

  it("checks this machine's own limits before the team's", async () => {
    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      (config) => {
        config.budgets.daily = 1;
      },
      { teamBudget: async () => status(100, 0) },
    );
    await gateway.store.usage.add({ sessionId: "s0", ts: gateway.clock.now, model: "m", cost: 2 });
    expect((await send("/s/s1/v1/messages")).text).toContain("the daily budget of $1.00");
  });
});

describe("LoopWatch", () => {
  const call = (id: string) => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm test" } }],
  });

  it("leaves out the calls already seen before hashing them", async () => {
    const body = { messages: [call("a"), call("b")] };
    expect((await toolCalls(body, new Set(["use:a"]))).map((entry) => entry.key)).toEqual(["use:b"]);
  });

  it("drops a session idle for too long, and neither counts nor returns its history when it comes back", async () => {
    let now = 0;
    const watch = new LoopWatch(3, 10, () => now, 1_000);
    const messages = [call("a"), call("b")];
    expect((await watch.observe("s1", { messages }, false)).fresh).toHaveLength(2);
    expect(watch.size).toBe(1);

    now = 120_000;
    await watch.observe("s2", { messages: [] }, false);
    expect(watch.size).toBe(1);

    messages.push(call("c"));
    const back = await watch.observe("s1", { messages }, false);
    expect(back).toEqual({ loops: [], fresh: [] });

    messages.push(call("d"));
    const next = await watch.observe("s1", { messages }, false);
    expect(next.fresh.map((use) => use.id)).toEqual(["d"]);
    expect(next.loops).toHaveLength(0);
    messages.push(call("e"), call("f"));
    expect((await watch.observe("s1", { messages }, false)).loops).toHaveLength(1);
  });
});
