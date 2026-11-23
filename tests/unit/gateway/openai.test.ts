import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { fakeUpstream, sse, type TestGateway, testGateway } from "../../support/gateway.ts";

const RESPONSES = new Uint8Array(readFileSync(new URL("../../fixtures/openai/responses-stream.sse", import.meta.url)));
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

  it("records a Chat Completions answer's usage", async () => {
    gateway = testGateway(fakeUpstream(() => new Response(CHAT, { headers: { "content-type": "application/json" } })));
    await (await gateway.request("/openai/v1/chat/completions", openaiRequest({ model: "gpt-5.1" }))).arrayBuffer();
    expect(await gateway.store.usage.list()).toMatchObject([
      { sessionId: "untagged", model: "gpt-5.1", inputTokens: 288, cacheReadTokens: 512, outputTokens: 40 },
    ]);
  });

  it("counts a model with no price as unpriced, not free", async () => {
    gateway = testGateway(fakeUpstream(() => new Response(CHAT, { headers: { "content-type": "application/json" } })));
    await (await gateway.request("/openai/v1/chat/completions", openaiRequest({ model: "gpt-5.1" }))).arrayBuffer();
    expect((await gateway.store.usage.list())[0]?.cost).toBeNull();
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
