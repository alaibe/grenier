import { readFileSync } from "node:fs";
import { type Config, defaultConfig } from "@grenier/core";
import { createGateway } from "@grenier/gateway";
import { loadPrices } from "@grenier/log";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";

export const PORT = 7788;
export const BASE = `http://127.0.0.1:${PORT}`;

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../fixtures/anthropic/${name}`, import.meta.url)));
}

export interface Upstream {
  requests: { url: string; method: string; headers: Headers; body: Uint8Array }[];
  fetch: typeof fetch;
}

/** A stand-in for api.anthropic.com: records what reaches it and answers with `respond`. */
export function fakeUpstream(respond: (request: Request) => Response | Promise<Response>): Upstream {
  const requests: Upstream["requests"] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = new Uint8Array(await request.clone().arrayBuffer());
    requests.push({ url: request.url, method: request.method, headers: request.headers, body });
    return respond(request);
  }) as typeof fetch;
  return { requests, fetch: fetchFn };
}

export function sse(body: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}

export interface TestGateway {
  store: Store;
  notifications: string[];
  request: (path: string, init?: RequestInit) => Promise<Response>;
  clock: { now: number };
}

export function testGateway(upstream: Upstream, configure: (config: Config) => void = () => {}): TestGateway {
  const config = defaultConfig();
  configure(config);
  const store = openSqliteStore(":memory:");
  const notifications: string[] = [];
  const clock = { now: new Date(2026, 10, 16, 12).getTime() };
  const app = createGateway({
    store,
    config,
    prices: loadPrices(),
    fetch: upstream.fetch,
    port: PORT,
    now: () => clock.now,
    notify: (title, message) => notifications.push(`${title}: ${message}`),
    pollInterval: 5,
    startedAt: 0,
  });
  return {
    store,
    notifications,
    clock,
    request: async (path, init = {}) => app.request(`${BASE}${path}`, init),
  };
}

export function messagesRequest(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-test-key",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}
