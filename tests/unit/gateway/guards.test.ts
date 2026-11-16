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

  it("applies a repository's budget to its sessions only", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    await gateway.store.budgets.set("repo", "app", 2);
    await spend("s1", 2, "app");
    await gateway.store.sessions.create({ id: "s2", startedAt: 0, repoId: "app", repoRoot: "/work/app" });
    await gateway.store.sessions.create({ id: "s3", startedAt: 0, repoId: "api", repoRoot: "/work/api" });

    expect((await send("/s/s2/v1/messages")).text).toContain("grenier budget set --repo app=<amount>");
    expect((await send("/s/s3/v1/messages")).status).toBe(200);
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
