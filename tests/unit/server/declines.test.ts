import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hash, SETUP_TOKEN } from "../../support/worker.ts";

/** The team store with a clock each request can set ahead, by its `x-ahead` header. */
const CLOCKED = `
import worker, { TeamStore as Store } from "./apps/server/src/index.ts";
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
const MINUTE = 60 * 1000;

let mf: Miniflare;

beforeEach(async () => {
  const bundle = await build({
    stdin: { contents: CLOCKED, resolveDir: new URL("../../../", import.meta.url).pathname, loader: "ts" },
    bundle: true,
    write: false,
    platform: "neutral",
    format: "esm",
    target: "es2023",
    external: ["cloudflare:workers"],
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    logLevel: "silent",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]?.text ?? "",
      compatibilityDate: "2026-11-01",
      durableObjects: { TEAM: { className: "TeamStore", useSQLite: true } },
      bindings: { SETUP_HASH: hash(SETUP_TOKEN) },
    }),
  );
}, 60_000);

afterEach(async () => {
  await mf.dispose();
});

const call = async (path: string, init: { method?: string; body?: unknown; ahead?: number } = {}) =>
  (await mf.dispatchFetch(`https://team.test${path}`, {
    method: init.method ?? "POST",
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    headers: {
      authorization: `Bearer ${SETUP_TOKEN}`,
      "content-type": "application/json",
      "x-ahead": String(init.ahead ?? 0),
    },
  })) as unknown as Response;

it("offers a declined request to the same machine again once its decline is 30 minutes old", async () => {
  expect((await call("/api/setup", { body: { member: "ada", device: "ada-mbp" } })).status).toBe(201);
  const change = (id: string, record: Record<string, unknown>) => ({
    id: `change-${id}`,
    recordId: id,
    baseVersion: 0,
    changed: Object.keys(record),
    record: { id, ...record },
  });
  const pushed = await call("/api/changes", {
    body: {
      changes: [
        change("routine", {
          top: "team",
          type: "Routine",
          title: "Update",
          body: "Update",
          fields: { trigger: "request" },
        }),
        change("task", {
          top: "team",
          type: "Task",
          title: "Bump hono",
          fields: { status: "to-do", routine: "routine" },
        }),
      ],
    },
  });
  expect((await pushed.json()) as { applied: unknown[] }).toMatchObject({ applied: [{}, {}] });
  const claim = async (ahead: number) => {
    await call("/api/machines/me", { method: "PUT", body: { state: "available", room: 1, agents: ["claude"] }, ahead });
    const { offer } = (await (await call("/api/work/claim", { ahead })).json()) as { offer: { task: { id: string } } };
    return offer?.task.id ?? null;
  };

  expect(await claim(0)).toBe("task");
  await call("/api/work/task/decline");
  expect(await claim(0)).toBeNull();
  expect(await claim(29 * MINUTE)).toBeNull();
  expect(await claim(31 * MINUTE)).toBe("task");
});
