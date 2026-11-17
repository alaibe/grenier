import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { npxWrangler, team } from "../../../apps/cli/src/commands/team.ts";
import { CommandError, type Io } from "../../../apps/cli/src/io.ts";
import { withTomlValue } from "../../../apps/cli/src/team.ts";

let dir: string;
let home: string;
let serverDir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-team-")));
  home = join(dir, ".grenier");
  serverDir = join(dir, "server");
  mkdirSync(join(serverDir, "migrations"), { recursive: true });
  writeFileSync(join(serverDir, "server.js"), "export default {};");
  writeFileSync(join(serverDir, "migrations", "0001_team.sql"), "CREATE TABLE members (id TEXT);");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const io = (): Io => ({ env: { GRENIER_HOME: home }, cwd: dir, out: () => {}, err: () => {}, self: [] });

/** Answers like Wrangler, and records what it was asked. */
function fakeWrangler(options: { loggedIn?: boolean; admins?: number } = {}) {
  const calls: { args: string[]; cwd?: string }[] = [];
  let created = false;
  const wrangler = async (args: string[], init: { cwd?: string } = {}) => {
    calls.push({ args, ...(init.cwd ? { cwd: init.cwd } : {}) });
    const command = args.slice(0, 2).join(" ");
    if (args[0] === "whoami") return options.loggedIn === false ? "You are not authenticated." : "You are logged in.";
    if (command === "d1 list") return JSON.stringify(created ? [{ name: "grenier-team", uuid: "db-123" }] : []);
    if (command === "d1 create") {
      created = true;
      return "Created";
    }
    if (args[0] === "deploy")
      return "Uploaded grenier-team\nDeployed grenier-team triggers\n  https://grenier-team.acme.workers.dev\n";
    if (command === "d1 execute" && args.includes("--json"))
      return JSON.stringify([{ results: [{ n: options.admins ?? 0 }] }]);
    return "";
  };
  return { calls, wrangler };
}

describe("grenier team deploy", () => {
  it("creates the database, applies migrations, deploys, adds the first admin and joins this machine", async () => {
    const { calls, wrangler } = fakeWrangler();
    const lines = await team(["deploy"], io(), { wrangler, serverDir });

    const serverHome = join(home, "team-server");
    expect(calls.map((call) => call.args.slice(0, 3).join(" "))).toEqual([
      "whoami",
      "d1 list --json",
      "d1 create grenier-team",
      "d1 list --json",
      "r2 bucket list",
      "r2 bucket create",
      "d1 migrations apply",
      "deploy",
      "d1 execute grenier-team",
      "d1 execute grenier-team",
    ]);
    expect(calls[5]?.args).toEqual(["r2", "bucket", "create", "grenier-team-vault"]);
    expect(calls[6]).toEqual({ args: ["d1", "migrations", "apply", "grenier-team", "--remote"], cwd: serverHome });
    expect(calls.every((call) => call.cwd === serverHome)).toBe(true);
    const insert = calls[9]?.args.at(-1) ?? "";
    expect(insert).toMatch(
      /^INSERT INTO members \(id, name, token_hash, role, created_at\) VALUES \('[\w-]+', 'admin', '[0-9a-f]{64}', 'admin', \d+\)$/,
    );

    const config = JSON.parse(readFileSync(join(serverHome, "wrangler.json"), "utf8"));
    expect(config).toMatchObject({
      name: "grenier-team",
      main: "server.js",
      d1_databases: [
        { binding: "DB", database_name: "grenier-team", database_id: "db-123", migrations_dir: "migrations" },
      ],
      durable_objects: { bindings: [{ name: "TEAM", class_name: "TeamCounter" }] },
      r2_buckets: [{ binding: "VAULT", bucket_name: "grenier-team-vault" }],
    });
    expect(readFileSync(join(serverHome, "server.js"), "utf8")).toBe("export default {};");

    const token = readFileSync(join(home, "team-token"), "utf8").trim();
    expect(token).toMatch(/^gt_[\w-]{43}$/);
    expect(statSync(join(home, "team-token")).mode & 0o777).toBe(0o600);
    expect(insert).not.toContain(token);
    expect((parse(readFileSync(join(home, "config.toml"), "utf8")) as { team: { url: string } }).team.url).toBe(
      "https://grenier-team.acme.workers.dev",
    );
    expect(lines[1]).toContain(token);
  });

  it("asks to log in to Cloudflare first", async () => {
    const { calls, wrangler } = fakeWrangler({ loggedIn: false });
    await expect(team(["deploy"], io(), { wrangler, serverDir })).rejects.toThrow("npx wrangler login");
    expect(calls).toHaveLength(1);
  });

  it("does not add a second admin to a server that has one", async () => {
    const { calls, wrangler } = fakeWrangler({ admins: 1 });
    const lines = await team(["deploy"], io(), { wrangler, serverDir });
    expect(calls.filter((call) => call.args.at(-1)?.startsWith("INSERT"))).toEqual([]);
    expect(lines[1]).toContain("already has an admin");
  });

  it("reports what Wrangler said when it fails, instead of crashing on its exit code", async () => {
    const failing = Object.assign(new Error("Command failed: npx"), {
      code: 1,
      stdout: "",
      stderr: "✘ [ERROR] A request to the Cloudflare API failed. [code: 7403]",
    });
    const wrangler = npxWrangler({}, async (_file, args) => {
      if (args.includes("whoami")) return { stdout: "You are logged in." };
      if (args.includes("list")) return { stdout: "[]" };
      throw failing;
    });

    const deploying = team(["deploy"], io(), { wrangler, serverDir });
    await expect(deploying).rejects.toBeInstanceOf(CommandError);
    await expect(deploying).rejects.toThrow(
      "wrangler d1 create failed:\n✘ [ERROR] A request to the Cloudflare API failed. [code: 7403]",
    );
  });

  it("refuses names that would not be safe in a Worker name or SQL", async () => {
    const { wrangler } = fakeWrangler();
    await expect(team(["deploy", "--name", "Bad Name"], io(), { wrangler, serverDir })).rejects.toThrow("--name");
    await expect(
      team(["deploy", "--admin", "x'); DROP TABLE members;--"], io(), { wrangler, serverDir }),
    ).rejects.toThrow("--admin");
  });
});

describe("grenier team join", () => {
  it("checks the token with the server, then saves the address and the token", async () => {
    const seen: string[] = [];
    const fetchStub = (async (input: URL | string, init: RequestInit = {}) => {
      seen.push(`${input} ${(init.headers as Record<string, string>).authorization}`);
      return Response.json({ name: "bob", role: "member" });
    }) as typeof fetch;
    const lines = await team(["join", "https://team.example.com/", "gt_bob"], io(), { fetch: fetchStub });
    expect(seen).toEqual(["https://team.example.com/api/me Bearer gt_bob"]);
    expect(lines[0]).toBe("Joined https://team.example.com as bob (member).");
    expect(readFileSync(join(home, "team-token"), "utf8")).toBe("gt_bob\n");
  });

  it("refuses plain http to another machine, and a token the server refuses", async () => {
    await expect(team(["join", "http://team.example.com", "t"], io())).rejects.toThrow("must use https");
    const refuse = (async () =>
      Response.json({ error: "a valid member token is needed" }, { status: 401 })) as unknown as typeof fetch;
    await expect(team(["join", "https://team.example.com", "bad"], io(), { fetch: refuse })).rejects.toThrow(
      "the team server answered: a valid member token is needed",
    );
  });
});

describe("withTomlValue", () => {
  it("sets a key in an existing table, adds it, or adds the table, keeping the rest", () => {
    const text = '# mine\n[proxy]\nport = 9000\n\n[team]\nurl = "old"\ntoken_env = "X"\n';
    expect(withTomlValue(text, "team", "url", "https://new")).toBe(
      '# mine\n[proxy]\nport = 9000\n\n[team]\nurl = "https://new"\ntoken_env = "X"\n',
    );
    expect(withTomlValue('[team]\ntoken_env = "X"\n', "team", "url", "u")).toBe('[team]\nurl = "u"\ntoken_env = "X"\n');
    expect(withTomlValue("[proxy]\nport = 1\n", "team", "url", "u")).toBe('[proxy]\nport = 1\n\n[team]\nurl = "u"\n');
    expect(withTomlValue("", "team", "url", "u")).toBe('[team]\nurl = "u"\n');
  });
});
