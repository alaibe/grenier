import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, defaultConfig } from "@grenier/core";
import { ensureDirectories, resolvePaths } from "@grenier/core/node";
import { createGateway } from "@grenier/gateway";
import { loadPrices } from "@grenier/log";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { type AdminDeps, createAdmin } from "../../apps/cli/src/admin/admin.ts";
import type { Runner } from "../../apps/cli/src/runner.ts";
import { storeDeps } from "./repo.ts";

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

export function testGateway(
  upstream: Upstream,
  configure: (config: Config) => void = () => {},
  extra: Partial<Parameters<typeof createGateway>[0]> = {},
): TestGateway {
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
    ...extra,
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

export const ADMIN_TOKEN = "ga_admin-test";

export interface TestAdmin {
  /** A request to /admin<path> with the admin token, as the app sends it; `origin` sets its Origin header. */
  call: (path: string, init?: RequestInit & { origin?: string }) => Promise<Response>;
  /** The status and JSON body of a request to /admin<path>. */
  reply: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  /** A request to any URL of the gateway, as it comes. */
  raw: (url: string, init?: RequestInit) => Promise<Response>;
  /** What reached the model provider through the proxy. */
  upstream: Upstream;
}

/** The admin API mounted in the gateway as the daemon mounts it: `home` is the user's, with Grenier's in .grenier. */
export function testAdmin(store: Store, home: string, deps: Partial<AdminDeps> = {}): TestAdmin {
  const config = defaultConfig();
  let current = config;
  const paths = resolvePaths({ GRENIER_HOME: join(home, ".grenier") });
  ensureDirectories(paths);
  const upstream = fakeUpstream(() => new Response("{}"));
  const admin = createAdmin({
    store,
    prices: loadPrices(),
    paths,
    config: () => current,
    reloaded: (next) => {
      current = next;
    },
    token: ADMIN_TOKEN,
    version: "test",
    storeDeps: () => storeDeps(store),
    team: () => null,
    sync: async (between) => {
      await between?.();
      return null;
    },
    joined: () => {},
    runner: { running: false, tick: async () => {}, state: async () => ({}), run: async () => {} } as unknown as Runner,
    where: { home, platform: "darwin", env: { GRENIER_HOME: paths.home }, self: ["/usr/local/bin/node", "grenier.js"] },
    ...deps,
  });
  const app = createGateway({ store, config, prices: loadPrices(), fetch: upstream.fetch, port: PORT, admin });
  const call: TestAdmin["call"] = async (path, init = {}) => {
    const { origin, ...rest } = init;
    return app.request(`${BASE}/admin${path}`, {
      ...rest,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
  };
  return {
    call,
    reply: async (method, path, body) => {
      const response = await call(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    raw: async (url, init) => app.request(url, init),
    upstream,
  };
}
