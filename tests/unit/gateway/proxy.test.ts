import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeUpstream, fixture, messagesRequest, sse, type TestGateway, testGateway } from "../../support/gateway.ts";

const STREAM = fixture("stream-tool-use.sse");
const MESSAGE = fixture("message.json");

let gateway: TestGateway;

afterEach(async () => {
  await gateway.store.close();
});

async function bytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

describe("passthrough", () => {
  it("replays a streamed response byte for byte, with its status and headers", async () => {
    const upstream = fakeUpstream(() =>
      sse(STREAM, { headers: { "content-type": "text/event-stream", "request-id": "req_1" } }),
    );
    gateway = testGateway(upstream);

    const response = await gateway.request(
      "/s/s1/v1/messages",
      messagesRequest({ model: "claude-opus-5-5", stream: true }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("request-id")).toBe("req_1");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await bytes(response)).toEqual(STREAM);
  });

  it("forwards method, path, query, headers and body unchanged, without the session prefix", async () => {
    const upstream = fakeUpstream(() => sse(STREAM));
    gateway = testGateway(upstream);
    const body = JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hé" }] });

    await gateway.request("/s/s1/v1/messages?beta=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-test-key",
        authorization: "Bearer oauth-token",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,context-1m",
        "accept-encoding": "gzip, br",
      },
      body,
    });

    const [sent] = upstream.requests;
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(sent?.method).toBe("POST");
    expect(new TextDecoder().decode(sent?.body)).toBe(body);
    expect(sent?.headers.get("x-api-key")).toBe("sk-ant-test-key");
    expect(sent?.headers.get("authorization")).toBe("Bearer oauth-token");
    expect(sent?.headers.get("anthropic-beta")).toBe("oauth-2025-04-20,context-1m");
    expect(sent?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(sent?.headers.get("accept-encoding")).toBe("identity");
  });

  it("sends a request without the prefix to the untagged session, and other endpoints through as they are", async () => {
    const upstream = fakeUpstream(() => Response.json({ data: [] }));
    gateway = testGateway(upstream);

    const response = await gateway.request("/v1/models?limit=1000");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [] });
    expect(upstream.requests[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(await gateway.store.sessions.get("untagged")).toBeDefined();
    expect(await gateway.store.usage.list()).toEqual([]);
  });

  it("streams each chunk as it arrives instead of waiting for the end", async () => {
    let push: (text: string) => void = () => {};
    let end: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text));
        end = () => controller.close();
      },
    });
    gateway = testGateway(fakeUpstream(() => sse(body as unknown as Uint8Array)));

    const response = await gateway.request("/s/s1/v1/messages", messagesRequest({}));
    const reader = response.body?.getReader();
    push("event: ping\ndata: {}\n\n");
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("event: ping\ndata: {}\n\n");
    push("event: ping\ndata: {}\n\n");
    expect((await reader?.read())?.done).toBe(false);
    end();
    expect((await reader?.read())?.done).toBe(true);
  });

  it("forwards an upstream error unchanged", async () => {
    const upstream = fakeUpstream(
      () => new Response(fixture("overloaded.json"), { status: 529, headers: { "content-type": "application/json" } }),
    );
    gateway = testGateway(upstream);

    const response = await gateway.request("/s/s1/v1/messages", messagesRequest({ model: "claude-opus-5-5" }));

    expect(response.status).toBe(529);
    expect(await bytes(response)).toEqual(fixture("overloaded.json"));
    expect(await gateway.store.usage.list()).toMatchObject([{ status: 529, model: "claude-opus-5-5", cost: 0 }]);
  });

  it("refuses a request addressed to another host", async () => {
    const upstream = fakeUpstream(() => sse(STREAM));
    gateway = testGateway(upstream);
    const response = await gateway.request("/v1/messages", {
      ...messagesRequest({}),
      headers: { host: "evil.example" },
    });
    expect(response.status).toBe(403);
    expect(upstream.requests).toEqual([]);
  });
});

describe("usage", () => {
  it("writes one row per request with the four token counts and the cost, from a stream", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));

    await (await gateway.request("/s/s1/v1/messages", messagesRequest({ model: "claude-opus-5-5" }))).arrayBuffer();

    const [row] = await gateway.store.usage.list();
    expect(row).toMatchObject({
      sessionId: "s1",
      model: "claude-opus-5-5",
      inputTokens: 12,
      cacheWriteTokens: 2048,
      cacheReadTokens: 30000,
      outputTokens: 87,
      status: 200,
    });
    expect(row?.cost).toBeCloseTo((12 * 4 + 87 * 20 + 30000 * 0.2 + 2048 * 5) / 1_000_000, 12);
  });

  it("reads the usage of a response that is not streamed", async () => {
    gateway = testGateway(
      fakeUpstream(() => new Response(MESSAGE, { headers: { "content-type": "application/json" } })),
    );

    const response = await gateway.request("/s/s1/v1/messages", messagesRequest({ model: "claude-sonnet-5-5" }));
    expect(await bytes(response)).toEqual(MESSAGE);

    expect(await gateway.store.usage.list()).toMatchObject([
      { model: "claude-sonnet-5-5", inputTokens: 420, outputTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it("records what a stream reported when the client goes away before the end", async () => {
    const half = STREAM.slice(0, new TextDecoder().decode(STREAM).indexOf("event: content_block_delta"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(half);
      },
    });
    gateway = testGateway(fakeUpstream(() => sse(body as unknown as Uint8Array)));
    const controller = new AbortController();

    const response = await gateway.request("/s/s1/v1/messages", { ...messagesRequest({}), signal: controller.signal });
    await response.body?.getReader().read();
    controller.abort();

    await vi.waitFor(async () =>
      expect(await gateway.store.usage.list()).toMatchObject([
        { inputTokens: 12, cacheReadTokens: 30000, outputTokens: 1 },
      ]),
    );
  });

  it("records what a stream reported when the upstream fails before the end", async () => {
    const half = STREAM.slice(0, new TextDecoder().decode(STREAM).indexOf("event: content_block_delta"));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(half);
        else controller.error(new Error("connection reset"));
      },
    });
    gateway = testGateway(fakeUpstream(() => sse(body as unknown as Uint8Array)));

    const response = await gateway.request("/s/s1/v1/messages", messagesRequest({ model: "claude-opus-5-5" }));
    await response.arrayBuffer().catch(() => undefined);

    expect(await gateway.store.usage.list()).toMatchObject([{ inputTokens: 12, cacheReadTokens: 30000 }]);
  });

  it("answers 502 in the API's own shape when the upstream cannot be reached", async () => {
    gateway = testGateway({
      requests: [],
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });

    const response = await gateway.request("/s/s1/v1/messages", messagesRequest({ model: "claude-opus-5-5" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
  });

  it("still answers when the usage row cannot be written, and logs why", async () => {
    const lines: string[] = [];
    gateway = testGateway(
      fakeUpstream(() => sse(STREAM)),
      () => {},
      { log: (line) => lines.push(line) },
    );
    gateway.store.usage.add = async () => {
      throw new Error("disk full");
    };

    const response = await gateway.request("/s/s1/v1/messages", messagesRequest({ model: "claude-opus-5-5" }));

    expect(await bytes(response)).toEqual(STREAM);
    expect(lines.join("\n")).toContain("disk full");
  });

  it("never stores the API key or the authorization header", async () => {
    gateway = testGateway(fakeUpstream(() => sse(STREAM)));
    await (
      await gateway.request(
        "/s/s1/v1/messages",
        messagesRequest({ model: "claude-opus-5-5" }, { authorization: "Bearer secret-oauth" }),
      )
    ).arrayBuffer();

    const everything = JSON.stringify([
      await gateway.store.sessions.list(),
      await gateway.store.usage.list(),
      await gateway.store.events.list(),
    ]);
    expect(everything).not.toContain("sk-ant-test-key");
    expect(everything).not.toContain("secret-oauth");
  });
});

describe("cache_control injection", () => {
  const plain = { model: "claude-opus-5-5", system: "You are terse.", messages: [{ role: "user", content: "hi" }] };

  it("is off by default: the body reaches the upstream unchanged", async () => {
    const upstream = fakeUpstream(() => sse(STREAM));
    gateway = testGateway(upstream);
    await gateway.request("/s/s1/v1/messages", messagesRequest(plain));
    expect(new TextDecoder().decode(upstream.requests[0]?.body)).toBe(JSON.stringify(plain));
    expect(await gateway.store.events.list({ kind: "request_changed" })).toEqual([]);
  });

  it("when turned on, adds a top-level cache_control to a request that has none, and logs the change", async () => {
    const upstream = fakeUpstream(() => sse(STREAM));
    gateway = testGateway(upstream, (config) => {
      config.proxy.inject_cache_control = true;
    });
    await gateway.request("/s/s1/v1/messages", messagesRequest(plain));
    expect(JSON.parse(new TextDecoder().decode(upstream.requests[0]?.body))).toEqual({
      ...plain,
      cache_control: { type: "ephemeral" },
    });
    const [event] = await gateway.store.events.list({ kind: "request_changed" });
    expect(JSON.parse(event?.detail ?? "{}")).toEqual({
      change: "added top-level cache_control",
      reason: "proxy.inject_cache_control",
    });
  });
});

describe("a routine's run", () => {
  function guarded(allowed: string[], available = { now: true }) {
    const cut: string[] = [];
    const upstream = fakeUpstream(() => sse(STREAM));
    gateway = testGateway(upstream, () => {}, {
      runGuard: async (session) =>
        session.id === "run1"
          ? {
              allows: (tool) => allowed.includes(tool),
              cut: (tool) => cut.push(tool),
              hold: async () => available.now && cut.length === 0,
            }
          : null,
    });
    return { cut, upstream };
  }

  it("passes the stream through whole when every tool call is allowed", async () => {
    guarded(["Read"]);
    const response = await gateway.request("/s/run1/v1/messages", messagesRequest({ model: "claude-opus-5-5" }));
    expect(await bytes(response)).toEqual(STREAM);
  });

  it("cuts the answer off before a tool call it may not make, and refuses the run's next call", async () => {
    const { cut, upstream } = guarded(["Grep"]);
    const response = await gateway.request("/s/run1/v1/messages", messagesRequest({ model: "claude-opus-5-5" }));
    const text = new TextDecoder().decode(await bytes(response));
    expect(text).not.toContain('"name":"Read"');
    expect(text).toContain("message_start");
    expect(text).toContain("Grenier cut this routine's run off: it may not call Read.");
    expect(cut).toEqual(["Read"]);
    const next = await gateway.request("/s/run1/v1/messages", messagesRequest({ model: "claude-opus-5-5" }));
    expect(next.status).toBe(529);
    expect(upstream.requests).toHaveLength(1);
  });

  it("checks a whole answer's tool calls too", async () => {
    const cut: string[] = [];
    const message = { type: "message", content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }] };
    gateway = testGateway(
      fakeUpstream(() => Response.json(message)),
      () => {},
      {
        runGuard: async () => ({
          allows: (tool) => tool === "Read",
          cut: (tool) => cut.push(tool),
          hold: async () => true,
        }),
      },
    );
    const response = await gateway.request("/s/run1/v1/messages", messagesRequest({ model: "claude-opus-5-5" }));
    expect(response.status).toBe(403);
    expect(cut).toEqual(["Edit"]);
  });

  it("holds nothing back for a session that is not a run", async () => {
    guarded([]);
    const response = await gateway.request("/s/other/v1/messages", messagesRequest({ model: "claude-opus-5-5" }));
    expect(await bytes(response)).toEqual(STREAM);
  });

  it("stops the run when its machine is no longer available", async () => {
    const state = { now: false };
    const { upstream } = guarded(["Read"], state);
    const response = await gateway.request("/s/run1/v1/messages", messagesRequest({ model: "claude-opus-5-5" }));
    expect(response.status).toBe(529);
    expect(upstream.requests).toHaveLength(0);
  });
});
