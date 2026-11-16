import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blobHashes, repoPath, trackedFiles } from "@grenier/connectors/git";
import { askCodebase, type CacheDeps, cosine, type Embedder, recordAnswer } from "@grenier/index";
import { DEFAULT_MODEL, loadLocalEmbedder } from "@grenier/index/node";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real model, downloaded from huggingface.co once into node_modules/.cache (or GRENIER_TEST_MODELS) and checked
// against its pinned SHA-256.
const MODELS =
  process.env.GRENIER_TEST_MODELS ??
  fileURLToPath(new URL("../../node_modules/.cache/grenier-models", import.meta.url));

let embedder: Embedder;
let dir: string;

beforeAll(async () => {
  mkdirSync(MODELS, { recursive: true });
  embedder = await loadLocalEmbedder(MODELS);
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-e2e-embed-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@x.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@x.invalid",
      },
    });
  git("init", "-q");
  writeFileSync(join(dir, "migrate.ts"), "export function migrate() {}\n");
  writeFileSync(join(dir, "proxy.ts"), "export function proxy() {}\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the default embedding model", () => {
  it("is the pinned potion-base-8M, 256 dimensions", () => {
    expect(embedder.model).toBe(`${DEFAULT_MODEL.repository}@${DEFAULT_MODEL.revision.slice(0, 7)}`);
    expect(embedder.dimensions).toBe(256);
  });

  it("puts a reworded question closer than an unrelated one", async () => {
    const [asked, reworded, unrelated] = await embedder.embed([
      "How is the database migrated on start?",
      "What runs the schema migrations when the app starts?",
      "How does the proxy stream responses back to the client?",
    ]);
    expect(cosine(asked as Float32Array, reworded as Float32Array)).toBeGreaterThan(0.5);
    expect(cosine(asked as Float32Array, unrelated as Float32Array)).toBeLessThan(0.4);
  });

  it("lets hybrid search find a reworded question that full text alone misses", async () => {
    const store = openSqliteStore(":memory:");
    const repo = { root: dir, id: "r" };
    const deps = (withVectors: boolean): CacheDeps => ({
      store,
      embedder: withVectors ? embedder : null,
      files: { hashes: blobHashes, tracked: trackedFiles, relative: repoPath },
    });
    await recordAnswer(deps(true), repo, {
      question: "How is the database migrated on start?",
      answer: "migrate.ts applies the SQL files in one transaction when the store opens.",
      files: ["migrate.ts"],
    });
    await recordAnswer(deps(true), repo, {
      question: "How does the proxy stream responses back to the client?",
      answer: "proxy.ts pipes the upstream body through a TransformStream.",
      files: ["proxy.ts"],
    });

    const reworded = "What runs the schema migrations when the app starts?";
    expect((await askCodebase(deps(false), repo, { question: reworded })).status).toBe("miss");
    expect(await askCodebase(deps(true), repo, { question: reworded })).toMatchObject({
      status: "hit",
      question: "How is the database migrated on start?",
    });
    await store.close();
  });
});
