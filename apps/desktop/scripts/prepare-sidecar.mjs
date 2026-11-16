// Gathers what the app bundles to run the daemon: Node's official standalone binary as the sidecar (named for Tauri
// with the target triple, downloaded once and checked against the SHA-256 pinned below), the CLI's bundle
// (dist/grenier.js and the team Worker), and better-sqlite3, the one dependency the bundle leaves outside. Run after
// `pnpm build` at the root.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const cli = join(app, "..", "cli");
if (!existsSync(join(cli, "dist", "grenier.js"))) throw new Error("build the CLI first: pnpm build");

// Node 22 LTS from nodejs.org, as its SHASUMS256.txt lists it. A package manager's node (Homebrew's) links a shared
// libnode and cannot be copied into an app.
const NODE = "22.23.5";
const BUILDS = {
  "aarch64-apple-darwin": ["darwin-arm64", "e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d"],
  "x86_64-apple-darwin": ["darwin-x64", "c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422"],
  "aarch64-unknown-linux-gnu": ["linux-arm64", "8bd3dc69eee8f3f226315a80d7d1d4faccf217a4c8fae500168ac2e38f3bdba3"],
  "x86_64-unknown-linux-gnu": ["linux-x64", "c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1"],
  "x86_64-pc-windows-msvc": ["win-x64", "4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3"],
};

const triple = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
const build = triple ? BUILDS[triple] : undefined;
if (!triple || !build) throw new Error(`no Node build pinned for ${triple ?? "this machine"}`);
const [platform, sha256] = build;
const windows = platform.startsWith("win");
const archive = `node-v${NODE}-${platform}.${windows ? "zip" : "tar.gz"}`;
const cache = join(app, ".cache");
mkdirSync(cache, { recursive: true });
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
execFileSync("tar", ["-xf", downloaded, "-C", cache, inside]);

const binaries = join(app, "src-tauri", "binaries");
mkdirSync(binaries, { recursive: true });
const sidecar = join(binaries, `grenier-node-${triple}${windows ? ".exe" : ""}`);
copyFileSync(join(cache, inside), sidecar);
chmodSync(sidecar, 0o755);

const resources = join(app, "resources", "grenier");
rmSync(resources, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
cpSync(join(cli, "dist"), join(resources, "dist"), { recursive: true });
writeFileSync(join(resources, "package.json"), `${JSON.stringify({ type: "module", private: true })}\n`);

const sqlite = dirname(createRequire(join(cli, "package.json")).resolve("better-sqlite3/package.json"));
for (const entry of ["package.json", "LICENSE", "lib", "prebuilds"]) {
  cpSync(join(sqlite, entry), join(resources, "node_modules", "better-sqlite3", entry), { recursive: true });
}
console.log(`sidecar ${sidecar}\nresources ${resources}`);
