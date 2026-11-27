import { type Embedder, type Reader, remember, type StoreDeps } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach } from "vitest";
import { storeDeps, TestRepo } from "../../support/repo.ts";

export let store: Store;
export let repo: TestRepo;
export let deps: StoreDeps;
export const PERSON: Reader = { id: "p", name: "person", scopes: ["*"] };

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  repo = new TestRepo({
    "src/router.ts": "export function route(path: string) {\n  return path.split('/');\n}\n",
    "src/server.ts": "import { route } from './router';\nexport const serve = () => route('/');\n",
    "README.md": "# app\n",
  });
  await repo.ready();
  deps = await storeDeps(store);
  await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
});

afterEach(async () => {
  await store.close();
  repo.remove();
});

/** Searches by this embedder's vectors from now on in the test. */
export async function embedWith(embedder: Embedder): Promise<void> {
  deps = await storeDeps(store, embedder);
}

export const answer = (title: string, body: string, files: string[]) =>
  remember(deps, null, repo.repo, { type: "Doc", title, body, files });
