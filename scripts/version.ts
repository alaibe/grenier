// `check` prints the version and fails when two files disagree; `bump` writes the next patch to all of them.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface VersionFile {
  path: string;
  pattern: RegExp;
}

const PACKAGE = /^ {2}"version": "([^"]+)",$/m;

export const FILES: VersionFile[] = [
  { path: "apps/cli/package.json", pattern: PACKAGE },
  { path: "apps/server/package.json", pattern: PACKAGE },
  { path: "apps/desktop/package.json", pattern: PACKAGE },
  { path: "apps/desktop/src-tauri/tauri.conf.json", pattern: PACKAGE },
  {
    path: "apps/desktop/src-tauri/Cargo.toml",
    pattern: /^\[package\]\nname = "grenier-desktop"\n[^[]*?^version = "([^"]+)"$/m,
  },
  { path: "apps/desktop/src-tauri/Cargo.lock", pattern: /^name = "grenier-desktop"\nversion = "([^"]+)"$/m },
];

function found(root: string, file: VersionFile): string {
  const version = file.pattern.exec(readFileSync(join(root, file.path), "utf8"))?.[1];
  if (!version) throw new Error(`no version in ${file.path}`);
  return version;
}

export function check(root: string): string {
  const versions = FILES.map((file) => ({ path: file.path, version: found(root, file) }));
  const first = versions[0];
  if (!first) throw new Error("no version files");
  const other = versions.find((entry) => entry.version !== first.version);
  if (other) throw new Error(`${other.path} is ${other.version}, ${first.path} is ${first.version}`);
  if (!/^\d+\.\d+\.\d+$/.test(first.version)) throw new Error(`${first.version} is not major.minor.patch`);
  return first.version;
}

export function bump(root: string): string {
  const [major, minor, patch] = check(root).split(".").map(Number);
  const next = `${major}.${minor}.${(patch ?? 0) + 1}`;
  for (const file of FILES) {
    const path = join(root, file.path);
    const text = readFileSync(path, "utf8");
    const match = file.pattern.exec(text);
    if (!match?.[1]) throw new Error(`no version in ${file.path}`);
    const line = match[0].replace(new RegExp(`"${match[1].replaceAll(".", "\\.")}"(,?)$`), `"${next}"$1`);
    writeFileSync(path, text.slice(0, match.index) + line + text.slice(match.index + match[0].length));
  }
  if (check(root) !== next) throw new Error(`the files do not all say ${next}`);
  return next;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const command = process.argv[2];
  if (command === "check") console.log(check(root));
  else if (command === "bump") console.log(bump(root));
  else {
    console.error("usage: node scripts/version.ts check|bump");
    process.exit(2);
  }
}
