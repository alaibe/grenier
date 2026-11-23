import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { team } from "../../../apps/cli/src/commands/team.ts";
import type { Io } from "../../../apps/cli/src/io.ts";
import { parseInvite, withTomlValue } from "../../../apps/cli/src/team.ts";

let dir: string;
let home: string;
let serverDir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-team-")));
  home = join(dir, ".grenier");
  mkdirSync(home);
  serverDir = join(dir, "server");
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(join(serverDir, "server.js"), "export default {};");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function io(): Io {
  return { env: { GRENIER_HOME: home }, cwd: dir, out: () => {}, err: () => {}, self: [] };
}

/** Answers like Wrangler, and records what it was asked. */
function fakeWrangler(options: { loggedIn?: boolean } = {}) {
  const calls: { args: string[]; cwd?: string }[] = [];
  const wrangler = async (args: string[], init: { cwd?: string } = {}) => {
    calls.push({ args, ...(init.cwd ? { cwd: init.cwd } : {}) });
    if (args[0] === "whoami") return options.loggedIn === false ? "You are not authenticated." : "You are logged in.";
    if (args[0] === "deploy") return "Uploaded grenier-team\n  https://grenier-team.acme.workers.dev\n";
    return "";
  };
  return { calls, wrangler };
}

describe("grenier team deploy", () => {
  it("deploys the team store with the setup token's hash, sets up this machine as admin, and saves the team", async () => {
    const { calls, wrangler } = fakeWrangler();
    let setupBody: unknown;
    const fetchStub = (async (url: URL, init: RequestInit) => {
      const config = JSON.parse(readFileSync(join(home, "team-server", "wrangler.json"), "utf8"));
      const token = String((init.headers as Record<string, string>).authorization).replace("Bearer ", "");
      expect(createHash("sha256").update(token).digest("hex")).toBe(config.vars.SETUP_HASH);
      expect(url.pathname).toBe("/api/setup");
      setupBody = JSON.parse(String(init.body));
      return Response.json({ member: "ada" }, { status: 201 });
    }) as unknown as typeof fetch;
    const lines = await team(["deploy", "--member", "ada"], io(), { wrangler, serverDir, fetch: fetchStub });

    const serverHome = join(home, "team-server");
    expect(calls.map((call) => call.args[0])).toEqual(["whoami", "deploy"]);
    expect(calls.every((call) => call.cwd === serverHome)).toBe(true);
    expect(JSON.parse(readFileSync(join(serverHome, "wrangler.json"), "utf8"))).toMatchObject({
      name: "grenier-team",
      main: "server.js",
      durable_objects: { bindings: [{ name: "TEAM", class_name: "TeamStore" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["TeamStore"] }],
    });
    expect(setupBody).toMatchObject({ member: "ada" });
    expect(parse(readFileSync(join(home, "config.toml"), "utf8"))).toMatchObject({
      team: { url: "https://grenier-team.acme.workers.dev" },
    });
    expect(statSync(join(home, "team-token")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "personal.key")).mode & 0o777).toBe(0o600);
    expect(lines[0]).toContain("you are its admin, ada");
  });
});

describe("invite links", () => {
  it("name the team store's host, the invite and its secret", () => {
    expect(parseInvite("grenier://join/grenier-team.acme.workers.dev/ab12/cd34")).toEqual({
      url: "https://grenier-team.acme.workers.dev",
      invite: "ab12",
      secret: "cd34",
    });
    expect(parseInvite("grenier://join/127.0.0.1:8787/ab/cd").url).toBe("http://127.0.0.1:8787");
    expect(() => parseInvite("https://example.com")).toThrow("grenier://join/");
  });
});

describe("withTomlValue", () => {
  it("adds a table, or sets a key inside an existing one, keeping the rest", () => {
    expect(withTomlValue("", "team", "url", "https://x")).toBe('[team]\nurl = "https://x"\n');
    expect(withTomlValue('[proxy]\nport = 1\n\n[team]\nurl = "old"\n', "team", "url", "new")).toBe(
      '[proxy]\nport = 1\n\n[team]\nurl = "new"\n',
    );
  });
});
