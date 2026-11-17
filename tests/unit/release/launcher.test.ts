import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const desktop = join(import.meta.dirname, "..", "..", "..", "apps", "desktop");
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "grenier-launcher-")));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (file: string, args: string[] = [], cwd = root) =>
  execFileSync(file, args, { cwd, encoding: "utf8" }).trimEnd().split("\n");

/** A stand-in for the app's Node that prints how it was called. */
function fakeNode(file: string) {
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$0" "$@"\n`);
  chmodSync(file, 0o755);
}

function install(launcher: string, file: string) {
  copyFileSync(join(desktop, "bin", launcher), file);
  chmodSync(file, 0o755);
}

describe.skipIf(process.platform === "win32")("the grenier command in the Mac app", () => {
  let contents: string;
  let command: string;

  beforeEach(() => {
    contents = join(root, "Applications", "Grenier 2.app", "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources", "grenier", "bin"), { recursive: true });
    fakeNode(join(contents, "MacOS", "grenier-node"));
    command = join(contents, "Resources", "grenier", "bin", "grenier");
    install("grenier", command);
  });

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

describe.skipIf(process.platform === "win32")("the grenier command in the deb and the rpm", () => {
  let bin: string;
  let command: string;

  beforeEach(() => {
    bin = join(root, "usr", "bin");
    mkdirSync(bin, { recursive: true });
    fakeNode(join(bin, "grenier-node"));
    command = join(bin, "grenier");
    install("grenier-linux", command);
  });

  const expected = (args: string[]) => [
    join(bin, "grenier-node"),
    `${bin}/../lib/Grenier/grenier/dist/grenier.js`,
    ...args,
  ];

  it("runs the Node beside it on the CLI in the app's resources, passing its arguments through", () => {
    expect(run(command, ["run", "--", "say hello"])).toEqual(expected(["run", "--", "say hello"]));
  });

  it("finds the app through a link", () => {
    const home = join(root, "home", "bin");
    mkdirSync(home, { recursive: true });
    symlinkSync(command, join(home, "grenier"));
    expect(run("./grenier", ["status"], home)).toEqual(expected(["status"]));
  });

  it("is what both packages install as /usr/bin/grenier, executable", () => {
    const config = JSON.parse(readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8"));
    for (const format of ["deb", "rpm"]) {
      const source = config.bundle.linux[format].files["/usr/bin/grenier"];
      expect(join(desktop, "src-tauri", source)).toBe(join(desktop, "bin", "grenier-linux"));
    }
    accessSync(join(desktop, "bin", "grenier-linux"), constants.X_OK);
  });
});
