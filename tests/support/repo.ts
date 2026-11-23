import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobHashes, repoId, repoPath, repoText, trackedFiles } from "@grenier/connectors/git";
import type { Embedder, Identity, Repo, RepoFiles, StoreDeps } from "@grenier/index";
import type { Store } from "@grenier/store";

export const gitFiles: RepoFiles = { hashes: blobHashes, tracked: trackedFiles, relative: repoPath, text: repoText };

/** Gives each listed text a fixed direction, so a test decides which texts are alike. Others get zeros. */
export class TableEmbedder implements Embedder {
  readonly model = "table";
  readonly dimensions = 3;
  constructor(readonly table: Record<string, [number, number, number]>) {}
  async embed(texts: readonly string[]) {
    return texts.map((text) => {
      const key = Object.keys(this.table).find((entry) => text === entry || text.startsWith(`${entry}\n`));
      return Float32Array.from(key ? (this.table[key] as [number, number, number]) : [0, 0, 0]);
    });
  }
}

/** A git repository in a temporary folder, with its first commit. */
export class TestRepo {
  readonly dir: string;
  repo!: Repo;

  constructor(files: Record<string, string> = { "README.md": "# app\n" }) {
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-repo-")));
    this.git("init", "-q");
    for (const [path, content] of Object.entries(files)) this.write(path, content);
    this.git("add", ".");
    this.git("commit", "-q", "-m", "first");
  }

  async ready(): Promise<Repo> {
    this.repo = { root: this.dir, id: (await repoId(this.dir)) as string };
    return this.repo;
  }

  write(path: string, content: string): void {
    mkdirSync(join(this.dir, path, ".."), { recursive: true });
    writeFileSync(join(this.dir, path), content);
  }

  git(...args: string[]): string {
    return this.gitAt(null, ...args);
  }

  /** Runs git with both of a commit's dates set to `ms`, or now with null. */
  gitAt(ms: number | null, ...args: string[]): string {
    const date =
      ms === null
        ? {}
        : { GIT_AUTHOR_DATE: `@${Math.floor(ms / 1000)}`, GIT_COMMITTER_DATE: `@${Math.floor(ms / 1000)}` };
    return execFileSync("git", ["-C", this.dir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@x.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@x.invalid",
        ...date,
      },
    });
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export const ADA: Identity = { member: "ada", device: "ada-mbp" };

export async function storeDeps(
  store: Store,
  embedder: Embedder | null = null,
  me: Identity = ADA,
): Promise<StoreDeps> {
  if (!(await store.spaces.get("me"))) {
    await store.spaces.put({ id: "me", name: "me", kind: "me", repoId: null, root: null });
  }
  return { store, embedder, files: gitFiles, me, now: () => 1_000 };
}
