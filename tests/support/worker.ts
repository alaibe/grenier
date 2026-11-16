import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const SERVER = new URL("../../apps/server/", import.meta.url);

/** The team Worker in Miniflare (local workerd, D1 and Durable Objects), with its migration applied. */
export async function startWorker(options: { listen?: boolean } = {}): Promise<{
  mf: Miniflare;
  call: (path: string, token?: string, init?: RequestInit) => Promise<Response>;
  /** Where it listens, with `listen`. */
  url: URL | null;
}> {
  const bundle = await build({
    entryPoints: [new URL("src/index.ts", SERVER).pathname],
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
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]?.text ?? "",
      compatibilityDate: "2026-11-01",
      d1Databases: { DB: "grenier-team-test" },
      durableObjects: { TEAM: { className: "TeamCounter", useSQLite: true } },
      r2Buckets: { VAULT: "grenier-team-vault" },
      ...(options.listen ? { host: "127.0.0.1", port: 0 } : {}),
    }),
  );
  const url = options.listen ? await mf.ready : null;
  const db = await mf.getD1Database("DB");
  const migration = readFileSync(new URL("migrations/0001_team.sql", SERVER), "utf8")
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await db.batch(migration.map((statement) => db.prepare(statement)));
  return {
    mf,
    url,
    call: (path, token, init = {}) =>
      mf.dispatchFetch(`https://team.test${path}`, {
        method: init.method ?? "GET",
        ...(init.body === undefined ? {} : { body: init.body as string }),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      }) as unknown as Promise<Response>,
  };
}

export function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
