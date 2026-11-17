import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const launcher = join(import.meta.dirname, "..", "..", "..", "apps", "desktop", "bin", "grenier");
let root: string;
let contents: string;
let command: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "grenier-launcher-")));
  contents = join(root, "Applications", "Grenier 2.app", "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources", "grenier", "bin"), { recursive: true });
  const node = join(contents, "MacOS", "grenier-node");
  writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$0" "$@"\n`);
  chmodSync(node, 0o755);
  command = join(contents, "Resources", "grenier", "bin", "grenier");
  copyFileSync(launcher, command);
  chmodSync(command, 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (file: string, args: string[] = [], cwd = root) =>
  execFileSync(file, args, { cwd, encoding: "utf8" }).trimEnd().split("\n");

describe.skipIf(process.platform === "win32")("the grenier command in the Mac app", () => {
  const expected = (args: string[]) => [
    join(contents, "MacOS", "grenier-node"),
    join(contents, "Resources", "grenier", "dist", "grenier.js"),
    ...args,
  ];

  it("runs the app's Node on the app's CLI, passing its arguments through", () => {
    expect(run(command, ["run", "--", "say hello"])).toEqual(expected(["run", "--", "say hello"]));
  });

  it("finds the app through an absolute link, as Homebrew's", () => {
    const bin = join(root, "opt", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(command, join(bin, "grenier"));
    expect(run(join(bin, "grenier"), ["status"])).toEqual(expected(["status"]));
  });

  it("finds the app through a chain of relative links, called from its own directory", () => {
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(command, join(first, "grenier"));
    symlinkSync("../first/grenier", join(second, "grenier"));
    expect(run("./grenier", ["status"], second)).toEqual(expected(["status"]));
  });
});
