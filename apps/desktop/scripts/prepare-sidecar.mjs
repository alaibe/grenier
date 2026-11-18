// Gathers what the app bundles to run the daemon: Node's official standalone binary as the sidecar (named for Tauri
// with the target triple, downloaded once and checked against the SHA-256 pinned below), the CLI's bundle
// (dist/grenier.js and the team Worker), better-sqlite3, the one dependency the bundle leaves outside, with only the
// target's prebuilt addon, and on a Mac the `grenier` command (bin/grenier) that the Homebrew cask links. The deb, the
// rpm and the Windows installer take theirs from tauri.conf.json and tauri.windows.conf.json. Run after `pnpm build` at
// the root:
//
//   node scripts/prepare-sidecar.mjs [--target <triple>]
//
// The target defaults to this machine's. `universal-apple-darwin` joins both Macs' Node with lipo, and keeps each
// Mac's own binary beside it: Tauri's build checks for those while it compiles each architecture.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const cli = join(app, "..", "cli");
if (!existsSync(join(cli, "dist", "grenier.js"))) throw new Error("build the CLI first: pnpm build");

// Node 22 LTS from nodejs.org, as its SHASUMS256.txt lists it, with better-sqlite3's prebuild for the same system. A
// package manager's node (Homebrew's) links a shared libnode and cannot be copied into an app.
const NODE = "22.23.5";
const BUILDS = {
  "aarch64-apple-darwin": ["darwin-arm64", "e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d"],
  "x86_64-apple-darwin": ["darwin-x64", "c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422"],
  "aarch64-unknown-linux-gnu": ["linux-arm64", "8bd3dc69eee8f3f226315a80d7d1d4faccf217a4c8fae500168ac2e38f3bdba3"],
  "x86_64-unknown-linux-gnu": ["linux-x64", "c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1"],
  "x86_64-pc-windows-msvc": ["win-x64", "4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3"],
};
const PREBUILDS = { "win-x64": "win32-x64" };
const UNIVERSAL = "universal-apple-darwin";
const MACS = ["aarch64-apple-darwin", "x86_64-apple-darwin"];

const { values } = parseArgs({ options: { target: { type: "string" } } });
const target = values.target ?? /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
const triples = target === UNIVERSAL ? MACS : [target];
if (!target || triples.some((triple) => !BUILDS[triple])) {
  throw new Error(`no Node build pinned for ${target ?? "this machine"}`);
}

const cache = join(app, ".cache");
const binaries = join(app, "src-tauri", "binaries");
mkdirSync(cache, { recursive: true });
mkdirSync(binaries, { recursive: true });

/** Node's binary for one triple, checked and copied to binaries/grenier-node-<triple>. */
async function sidecar(triple) {
  const [platform, sha256] = BUILDS[triple];
  const windows = platform.startsWith("win");
  const archive = `node-v${NODE}-${platform}.${windows ? "zip" : "tar.gz"}`;
  const downloaded = join(cache, archive);
  if (!existsSync(downloaded)) {
    const response = await fetch(`https://nodejs.org/dist/v${NODE}/${archive}`);
    if (!response.ok) throw new Error(`could not download ${archive}: HTTP ${response.status}`);
    writeFileSync(downloaded, Buffer.from(await response.arrayBuffer()));
  }
  const actual = createHash("sha256").update(readFileSync(downloaded)).digest("hex");
  if (actual !== sha256) {
    rmSync(downloaded);
    throw new Error(`${archive} has SHA-256 ${actual}, expected ${sha256}`);
  }
  const inside = `node-v${NODE}-${platform}/${windows ? "node.exe" : "bin/node"}`;
  // GNU tar cannot read a zip; Windows' own tar can, and has no unzip.
  if (windows && process.platform !== "win32") execFileSync("unzip", ["-o", "-q", downloaded, inside, "-d", cache]);
  else execFileSync("tar", ["-xf", downloaded, "-C", cache, inside]);
  const file = join(binaries, `grenier-node-${triple}${windows ? ".exe" : ""}`);
  copyFileSync(join(cache, inside), file);
  chmodSync(file, 0o755);
  return file;
}

const files = [];
for (const triple of triples) files.push(await sidecar(triple));
if (target === UNIVERSAL) {
  const universal = join(binaries, `grenier-node-${UNIVERSAL}`);
  execFileSync("lipo", ["-create", "-output", universal, ...files]);
  files.push(universal);
}

const resources = join(app, "resources", "grenier");
rmSync(resources, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
cpSync(join(cli, "dist"), join(resources, "dist"), { recursive: true });
writeFileSync(join(resources, "package.json"), `${JSON.stringify({ type: "module", private: true })}\n`);

const sqlite = dirname(createRequire(join(cli, "package.json")).resolve("better-sqlite3/package.json"));
const copied = join(resources, "node_modules", "better-sqlite3");
for (const entry of ["package.json", "LICENSE", "lib"])
  cpSync(join(sqlite, entry), join(copied, entry), { recursive: true });
for (const triple of triples) {
  const [platform] = BUILDS[triple];
  const addon = `${PREBUILDS[platform] ?? platform}.node`;
  cpSync(join(sqlite, "prebuilds", addon), join(copied, "prebuilds", addon));
}
if (triples.every((triple) => triple.endsWith("-apple-darwin"))) {
  const command = join(resources, "bin", "grenier");
  mkdirSync(dirname(command), { recursive: true });
  copyFileSync(join(app, "bin", "grenier"), command);
  chmodSync(command, 0o755);
}
console.log(`sidecar ${files.join(" ")}\nresources ${resources}`);
