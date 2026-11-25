import { createHash } from "node:crypto";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const SERVER = new URL("../../apps/server/", import.meta.url);

/** The token that sets up the first admin in tests. */
export const SETUP_TOKEN = "gt_setup_token_for_tests_only_0123456789abcdef";

export function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The team store with a clock each request sets ahead, in milliseconds, by its `x-ahead` header. */
const CLOCKED = `
import worker, { TeamStore as Store } from "./src/index.ts";
const real = Date.now;
let ahead = 0;
Date.now = () => real() + ahead;
export class TeamStore extends Store {
  async fetch(request) {
    ahead = Number(request.headers.get("x-ahead") ?? 0);
    return super.fetch(request);
  }
}
export default worker;
`;

/** The team Worker in Miniflare (local workerd and its Durable Object); with `clock`, `ahead` moves its time on. */
export async function startWorker(options: { listen?: boolean; clock?: boolean } = {}): Promise<{
  mf: Miniflare;
  call: (path: string, token?: string, init?: { method?: string; body?: unknown; ahead?: number }) => Promise<Response>;
  /** Where it listens, with `listen`. */
  url: URL | null;
  fetch: typeof fetch;
}> {
  const bundle = await build({
    ...(options.clock
      ? { stdin: { contents: CLOCKED, resolveDir: SERVER.pathname, loader: "ts" as const } }
      : { entryPoints: [new URL("src/index.ts", SERVER).pathname] }),
    bundle: true,
    write: false,
    platform: "neutral",
    format: "esm",
    target: "es2023",
    external: ["cloudflare:workers"],
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    loader: { ".css": "text" },
    logLevel: "silent",
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]?.text ?? "",
      compatibilityDate: "2026-11-01",
      durableObjects: { TEAM: { className: "TeamStore", useSQLite: true } },
      bindings: { SETUP_HASH: hash(SETUP_TOKEN) },
      ...(options.listen ? { host: "127.0.0.1", port: 0 } : {}),
    }),
  );
  const url = options.listen ? await mf.ready : null;
  const fetchFromWorker = ((input: URL | string | Request, init?: RequestInit) =>
    mf.dispatchFetch(input instanceof Request ? input.url : String(input), init as never)) as unknown as typeof fetch;
  return {
    mf,
    url,
    fetch: fetchFromWorker,
    call: (path, token, init = {}) =>
      mf.dispatchFetch(`https://team.test${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.ahead === undefined ? {} : { "x-ahead": String(init.ahead) }),
          "content-type": "application/json",
        },
      }) as unknown as Promise<Response>,
  };
}
