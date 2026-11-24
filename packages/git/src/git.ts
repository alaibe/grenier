import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const child = run("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  if (input !== undefined) child.child.stdin?.end(input);
  return (await child).stdout;
}

/** The top of the work tree that holds `cwd`, or null outside a repository (or without git). */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

/** Where the repository lives on this machine: for a linked worktree, such as a routine run's checkout, its main one. */
export async function repoHome(root: string): Promise<string> {
  try {
    const common = (await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    return basename(common) === ".git" ? dirname(common) : root;
  } catch {
    return root;
  }
}

/** The repository's identity across clones: its first commit's id, the smallest of several roots. */
export async function repoId(root: string): Promise<string | null> {
  try {
    const roots = (await git(root, ["rev-list", "--max-parents=0", "HEAD"])).split("\n").filter(Boolean).sort();
    return roots[0] ?? null;
  } catch {
    return null;
  }
}

/** A path inside the repository, relative to its root with forward slashes, or null for one outside it. */
export function repoPath(root: string, path: string): string | null {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const inside = relative(root, absolute);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
  return inside.split(sep).join("/");
}

/** Each file's blob hash as it is now in the work tree, staged or not; null for a file that is gone. */
export async function blobHashes(root: string, paths: readonly string[]): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>();
  const present: string[] = [];
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (existsSync(absolute) && statSync(absolute).isFile()) present.push(path);
    else hashes.set(path, null);
  }
  if (present.length > 0) {
    const out = await git(root, ["hash-object", "--stdin-paths"], `${present.join("\n")}\n`);
    const lines = out.split("\n").filter(Boolean);
    present.forEach((path, index) => {
      hashes.set(path, lines[index] ?? null);
    });
  }
  return hashes;
}

/** Every file git tracks, relative to the root, with the blob hash staged for it. */
export async function trackedFiles(root: string): Promise<{ path: string; blob: string }[]> {
  const out = await git(root, ["ls-files", "--stage", "-z"]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [meta = "", path = ""] = entry.split("\t");
      return { path, blob: meta.split(" ")[1] ?? "" };
    });
}

/** The most a file Grenier reads from a work tree may weigh. */
export const MAX_TEXT_BYTES = 1_000_000;

/** A work-tree text file, or null when missing, binary, too large, or outside the root once links are followed. */
export async function repoText(root: string, path: string, maxBytes = MAX_TEXT_BYTES): Promise<string | null> {
  try {
    const realRoot = await realpath(root);
    const real = await realpath(resolve(realRoot, path));
    const inside = relative(realRoot, real);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
    const file = await open(real, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) return null;
      const bytes = await file.readFile();
      if (bytes.subarray(0, 8000).includes(0)) return null;
      return new TextDecoder().decode(bytes);
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/** A blob's text as git keeps it, or null when this clone does not have it (it was never added) or it is not text. */
export async function blobText(root: string, blob: string): Promise<string | null> {
  if (!/^[0-9a-f]{40,64}$/.test(blob)) return null;
  try {
    const text = await git(root, ["cat-file", "-p", blob]);
    return text.slice(0, 8000).includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/** A repository's files as the store reads them, which `RepoFiles` in @grenier/index describes. */
export const gitFiles = { hashes: blobHashes, tracked: trackedFiles, relative: repoPath, text: repoText };
