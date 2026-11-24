import { readFileSync } from "node:fs";
import { allowedTools, mayCall, type RoutineMode } from "@grenier/core";
import { afterEach, describe, expect, it } from "vitest";
import { fakeUpstream, sse, type TestGateway, testGateway } from "../../support/gateway.ts";

const RESPONSES = new Uint8Array(readFileSync(new URL("../../fixtures/openai/responses-stream.sse", import.meta.url)));
/** Codex reading with its shell and Grenier's recall, then patching a file: Responses API events as it streams them. */
const TOOL_CALLS = new Uint8Array(
  readFileSync(new URL("../../fixtures/openai/responses-tool-calls.sse", import.meta.url)),
);
const CHAT = new Uint8Array(readFileSync(new URL("../../fixtures/openai/chat-completion.json", import.meta.url)));

let gateway: TestGateway;

afterEach(async () => {
  await gateway.store.close();
});

const openaiRequest = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer sk-openai-test" },
  body: JSON.stringify(body),
});

describe("OpenAI-compatible endpoints", () => {
  it("sends /openai/ requests to the OpenAI upstream, unchanged, and streams the answer byte for byte", async () => {
    const upstream = fakeUpstream(() => sse(RESPONSES));
    gateway = testGateway(upstream);

    const response = await gateway.request(
      "/s/s1/openai/v1/responses",
      openaiRequest({ model: "gpt-5.1-codex", stream: true }),
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(RESPONSES);
    expect(upstream.requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(upstream.requests[0]?.headers.get("authorization")).toBe("Bearer sk-openai-test");
  });

  it("records a Responses stream's usage, with cached input as cache reads", async () => {
    gateway = testGateway(fakeUpstream(() => sse(RESPONSES)));
    await (await gateway.request("/s/s1/openai/v1/responses", openaiRequest({ model: "gpt-5.1-codex" }))).arrayBuffer();
    expect(await gateway.store.usage.list()).toMatchObject([
      {
        sessionId: "s1",
        model: "gpt-5.1-codex",
        inputTokens: 904,
        cacheReadTokens: 4096,
        cacheWriteTokens: 0,
        outputTokens: 120,
      },
    ]);
  });

  it("records a Chat Completions answer's usage, a model with no price as unpriced, not free", async () => {
    gateway = testGateway(fakeUpstream(() => new Response(CHAT, { headers: { "content-type": "application/json" } })));
    await (await gateway.request("/openai/v1/chat/completions", openaiRequest({ model: "gpt-5.1" }))).arrayBuffer();
    expect(await gateway.store.usage.list()).toMatchObject([
      { sessionId: "untagged", model: "gpt-5.1", inputTokens: 288, cacheReadTokens: 512, outputTokens: 40, cost: null },
    ]);
  });

  it("refuses a ChatGPT sign-in bound for OpenAI's API with a message saying what to do, without forwarding it", async () => {
    const upstream = fakeUpstream(() => sse(RESPONSES));
    gateway = testGateway(upstream);
    const init = openaiRequest({ model: "gpt-5.1-codex" });
    const response = await gateway.request("/s/s1/openai/v1/responses", {
      ...init,
      headers: { ...(init.headers as Record<string, string>), "chatgpt-account-id": "acct-1" },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      "codex login --with-api-key",
    );
    expect(upstream.requests).toEqual([]);
  });

  it("honours upstream_openai, for any OpenAI-compatible API", async () => {
    const upstream = fakeUpstream(() => sse(RESPONSES));
    gateway = testGateway(upstream, (config) => {
      config.proxy.upstream_openai = "http://127.0.0.1:11434/";
    });
    await gateway.request("/s/s1/openai/v1/chat/completions", openaiRequest({ model: "local" }));
    expect(upstream.requests[0]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });
});

describe("a Codex routine's run", () => {
  /** The runner's own rule for a Codex run in this mode, counting what it is asked. */
  function codexRun(mode: RoutineMode, respond: () => Response) {
    const asked: string[] = [];
    const cut: string[] = [];
    const upstream = fakeUpstream(respond);
    const allowed = allowedTools(mode, [], "codex");
    gateway = testGateway(upstream, () => {}, {
      runGuard: async (session) =>
        session.id === "run1"
          ? {
              allows: (tool) => {
                asked.push(tool);
                return mayCall("codex", allowed, tool);
              },
              cut: (tool) => cut.push(tool),
              hold: async () => cut.length === 0,
            }
          : null,
    });
    return { asked, cut, upstream };
  }
  const send = () => gateway.request("/s/run1/openai/v1/responses", openaiRequest({ model: "gpt-5.1-codex" }));

  it("cuts a read-only run's stream before apply_patch, and lets its shell and Grenier's recall through", async () => {
    const { asked, cut, upstream } = codexRun("read-only", () => sse(TOOL_CALLS));
    const text = await (await send()).text();
    expect(asked).toEqual(["exec_command", "mcp__grenier__recall", "apply_patch"]);
    expect(cut).toEqual(["apply_patch"]);
    expect(text).toContain('"name":"exec_command"');
    expect(text).toContain('"name":"recall"');
    expect(text).not.toContain('"name":"apply_patch"');
    expect(text).not.toContain("*** Begin Patch");
    expect(text.trimEnd().split("\n\n").at(-1)).toMatch(/^event: response\.failed\ndata: .*may not call apply_patch/);
    expect((await send()).status).toBe(529);
    expect(upstream.requests).toHaveLength(1);
  });

  it("passes a run that may act through byte for byte, asking once for each call", async () => {
    const { asked, cut } = codexRun("on", () => sse(TOOL_CALLS));
    expect(new Uint8Array(await (await send()).arrayBuffer())).toEqual(TOOL_CALLS);
    expect(asked).toEqual(["exec_command", "mcp__grenier__recall", "apply_patch"]);
    expect(cut).toEqual([]);
  });

  it("holds a shadow run to its mode in a whole answer too, and any MCP tool it was not given", async () => {
    const whole = (item: Record<string, unknown>) => () => Response.json({ object: "response", output: [item] });
    const patch = { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Begin Patch" };
    codexRun("shadow", whole(patch));
    expect((await send()).status).toBe(403);
    const linear = { type: "function_call", call_id: "c2", namespace: "mcp__linear", name: "update_issue" };
    const { cut } = codexRun("on", whole(linear));
    expect((await send()).status).toBe(403);
    expect(cut).toEqual(["mcp__linear__update_issue"]);
  });
});
