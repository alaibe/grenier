import { LoopWatch } from "@grenier/gateway";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("cost", () => {
  it("never refuses a request for what was spent", async () => {
    const upstream = fakeUpstream(() => sse(STREAM));
    gateway = testGateway(upstream);
    await gateway.store.sessions.create({ id: "earlier", startedAt: gateway.clock.now });
    await gateway.store.usage.add({ sessionId: "earlier", ts: gateway.clock.now, model: "claude-opus-5-5", cost: 500 });

    expect((await send("/s/s1/v1/messages")).status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
  });

  it("lets a model with no price through, and says once that it counts as $0", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    expect((await send("/s/s1/v1/messages", { model: "mystery-model" })).status).toBe(200);
    expect((await send("/s/s2/v1/messages", { model: "mystery-model" })).status).toBe(200);
    expect(gateway.notifications.filter((line) => line.includes("mystery-model"))).toHaveLength(1);
    expect(await gateway.store.events.list({ kind: "unpriced" })).toHaveLength(1);
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
    await vi.waitFor(async () => expect((await gateway.store.sessions.get("s1"))?.paused).toBe(true));
    expect(settled).toBe(false);
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
    await vi.waitFor(async () => expect((await gateway.store.sessions.get("s1"))?.paused).toBe(true));
    expect((await gateway.store.events.list({ kind: "pause" })).length).toBe(2);
    await gateway.store.sessions.setPaused("s1", false);
  });
});

describe("LoopWatch", () => {
  const call = (id: string) => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm test" } }],
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
