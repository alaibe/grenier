import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobHashes, repoHome, repoId, repoPath, repoRoot, repoText, trackedFiles } from "@grenier/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-git-")));
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "README.md"), "# t\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("repoRoot and repoId", () => {
  it("finds the work tree's top from a subdirectory, and the first commit", async () => {
    expect(await repoRoot(join(dir, "src"))).toBe(dir);
    const first = git("rev-list", "--max-parents=0", "HEAD");
    writeFileSync(join(dir, "b.txt"), "b");
    git("add", ".");
    git("commit", "-q", "-m", "second");
    expect(await repoId(dir)).toBe(first);
  });

  it("knows where a linked worktree's repository lives, as a routine run's checkout is", async () => {
    const checkout = join(realpathSync(mkdtempSync(join(tmpdir(), "grenier-run-"))), "app");
    git("worktree", "add", "--detach", checkout, "HEAD");
    expect(await repoRoot(checkout)).toBe(checkout);
    expect(await repoHome(checkout)).toBe(dir);
    expect(await repoHome(dir)).toBe(dir);
    git("worktree", "remove", "--force", checkout);
  });
});

describe("repoPath", () => {
  it("makes a path relative to the root and refuses one outside it", () => {
    expect(repoPath("/r", "src/a.ts")).toBe("src/a.ts");
    expect(repoPath("/r", "/r/src/a.ts")).toBe("src/a.ts");
    expect(repoPath("/r", "../etc/passwd")).toBeNull();
    expect(repoPath("/r", "/etc/passwd")).toBeNull();
    expect(repoPath("/r", "/r")).toBeNull();
  });
});

describe("blobHashes", () => {
  it("matches git's hash for a committed file, changes with an unstaged edit, and is null once deleted", async () => {
    const committed = git("rev-parse", "HEAD:src/a.ts");
    expect((await blobHashes(dir, ["src/a.ts"])).get("src/a.ts")).toBe(committed);

    writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
    const edited = (await blobHashes(dir, ["src/a.ts"])).get("src/a.ts");
    expect(edited).not.toBe(committed);
    expect(edited).toMatch(/^[0-9a-f]{40}$/);

    unlinkSync(join(dir, "src/a.ts"));
    expect(await blobHashes(dir, ["src/a.ts", "README.md"])).toEqual(
      new Map([
        ["src/a.ts", null],
        ["README.md", git("rev-parse", "HEAD:README.md")],
      ]),
    );
  });
});

describe("trackedFiles", () => {
  it("lists tracked files with their staged blob", async () => {
    expect((await trackedFiles(dir)).map((file) => file.path)).toEqual(["README.md", "src/a.ts"]);
    expect((await trackedFiles(dir))[1]?.blob).toBe(git("rev-parse", "HEAD:src/a.ts"));
  });
});

describe("repoText", () => {
  it("reads a text file of the work tree", async () => {
    expect(await repoText(dir, "src/a.ts")).toBe("export const a = 1;\n");
  });

  it("refuses what is outside the root, by path or by link, and binary, large or missing files", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "grenier-outside-")));
    try {
      writeFileSync(join(outside, "secret.txt"), "not yours\n");
      symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
      writeFileSync(join(dir, "image.bin"), Buffer.from([1, 0, 2]));
      writeFileSync(join(dir, "big.txt"), "x".repeat(100));

      expect(await repoText(dir, `../${outside.split("/").at(-1)}/secret.txt`)).toBeNull();
      expect(await repoText(dir, join(outside, "secret.txt"))).toBeNull();
      expect(await repoText(dir, "link.txt")).toBeNull();
      expect(await repoText(dir, "image.bin")).toBeNull();
      expect(await repoText(dir, "big.txt", 50)).toBeNull();
      expect(await repoText(dir, "missing.ts")).toBeNull();
      expect(await repoText(dir, "src")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
