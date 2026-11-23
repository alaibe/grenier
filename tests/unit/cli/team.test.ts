import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inviteLink, npxWrangler, parseInvite, team } from "../../../apps/cli/src/commands/team.ts";
import type { Io } from "../../../apps/cli/src/io.ts";
import { saveTeam, withTomlValue } from "../../../apps/cli/src/team.ts";
import { SETUP_TOKEN, startWorker } from "../../support/worker.ts";

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

function io(homeDir = home, err: string[] = []): Io {
  return { env: { GRENIER_HOME: homeDir }, cwd: dir, out: () => {}, err: (line) => err.push(line), self: [] };
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

  it("asks to log in to Cloudflare first, before deploying anything", async () => {
    const { calls, wrangler } = fakeWrangler({ loggedIn: false });
    await expect(team(["deploy"], io(), { wrangler, serverDir })).rejects.toThrow("npx wrangler login");
    expect(calls.map((call) => call.args[0])).toEqual(["whoami"]);
  });

  it("reports what Wrangler said when it fails, instead of crashing on its exit code", async () => {
    const exec = async () => {
      throw Object.assign(new Error("Command failed"), { stderr: "✘ [ERROR] Authentication error", stdout: "" });
    };
    await expect(npxWrangler({}, exec)(["deploy"])).rejects.toThrow(
      "wrangler deploy failed:\n✘ [ERROR] Authentication error",
    );
  });
});

describe("invite links", () => {
  it("names the team store's host, the invite and its secret, and reads them back", () => {
    const link = inviteLink("https://grenier-team.acme.workers.dev", "ab12", "cd34");
    expect(link).toBe("grenier://join/grenier-team.acme.workers.dev/ab12/cd34");
    expect(parseInvite(link)).toEqual({ url: "https://grenier-team.acme.workers.dev", invite: "ab12", secret: "cd34" });
    expect(parseInvite("grenier://join/127.0.0.1:8787/ab/cd").url).toBe("http://127.0.0.1:8787");
    expect(() => parseInvite("https://example.com")).toThrow("grenier://join/");
  });
});

describe("joining a team", () => {
  it("joins from a link once the admin confirms the code the new machine shows", async () => {
    const worker = await startWorker();
    try {
      await worker.call("/api/setup", SETUP_TOKEN, { body: { member: "ada", device: "ada-mbp" } });
      saveTeam(
        { home, config: join(home, "config.toml"), db: join(home, "grenier.db") },
        "https://team.test",
        SETUP_TOKEN,
      );
      const adminIo = io();
      const lines = await team(["invite", "bob"], adminIo, { fetch: worker.fetch });
      const link = lines[1] as string;
      expect(link).toMatch(/^grenier:\/\/join\/team\.test\//);

      const bobHome = join(dir, ".bob");
      mkdirSync(bobHome);
      const bobErr: string[] = [];
      let confirmed = false;
      const joined = team(["join", link], io(bobHome, bobErr), {
        fetch: worker.fetch,
        sleep: async () => {
          if (confirmed) return;
          const code = /Your code: (\d{3}) (\d{3})/.exec(bobErr.join("\n"));
          expect(code).not.toBeNull();
          const pending = await team(["pending"], adminIo, { fetch: worker.fetch });
          expect(pending[0]).toContain(`code ${code?.[1]}${code?.[2]}`);
          await team(["confirm", `${code?.[1]} ${code?.[2]}`], adminIo, { fetch: worker.fetch });
          confirmed = true;
        },
      });
      expect((await joined)[0]).toMatch(/^Joined https:\/\/team\.test as bob \(member\)/);
      expect(parse(readFileSync(join(bobHome, "config.toml"), "utf8"))).toMatchObject({
        team: { url: "https://team.test" },
      });
      const members = await team(["members"], adminIo, { fetch: worker.fetch });
      expect(members.map((line) => line.split(/\s+/)[0])).toEqual(["ada", "bob"]);
      await expect(team(["role", "ada", "member"], adminIo, { fetch: worker.fetch })).rejects.toThrow(
        "at least one admin",
      );
    } finally {
      await worker.mf.dispose();
    }
  }, 60_000);
});

describe("withTomlValue", () => {
  it("adds a table, or sets a key inside an existing one, keeping the rest", () => {
    expect(withTomlValue("", "team", "url", "https://x")).toBe('[team]\nurl = "https://x"\n');
    expect(withTomlValue('[proxy]\nport = 1\n\n[team]\nurl = "old"\n', "team", "url", "new")).toBe(
      '[proxy]\nport = 1\n\n[team]\nurl = "new"\n',
    );
  });
});
