import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SETUP_TOKEN, startWorker } from "../support/worker.ts";

const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));

let dir: string;
let mf: Miniflare;
let teamUrl: string;

interface Machine {
  home: string;
  repo: string;
  /** Put first on the machine's PATH: machine B's stand-in agent. */
  bin?: string;
  /** The MCP client's token, as `grenier mcp install` gives one. */
  token?: string;
}
const machines: Record<"a" | "b", Machine> = { a: { home: "", repo: "" }, b: { home: "", repo: "" } };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const pathOf = (machine: Machine) =>
  machine.bin ? `${machine.bin}${delimiter}${process.env.PATH ?? ""}` : (process.env.PATH ?? "");

function grenier(machine: Machine, ...args: string[]) {
  return promisify(execFile)(BINARY, args, {
    cwd: machine.repo,
    env: { PATH: pathOf(machine), GRENIER_HOME: machine.home },
  });
}

async function tool(machine: Machine, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: BINARY,
      args: ["mcp", "serve"],
      cwd: machine.repo,
      env: {
        PATH: pathOf(machine),
        GRENIER_HOME: machine.home,
        ...(machine.token ? { GRENIER_CLIENT_TOKEN: machine.token } : {}),
      },
      stderr: "pipe",
    }),
  );
  try {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-e2e-team-")));
  const started = await startWorker({ listen: true });
  mf = started.mf;
  teamUrl = (started.url as URL).origin;
  await fetch(`${teamUrl}/api/setup`, {
    method: "POST",
    headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ member: "ada", device: "ada-mbp" }),
  });

  const source = join(dir, "source");
  mkdirSync(source);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@x.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@x.invalid",
  };
  execFileSync("git", ["-C", source, "init", "-q"], { env });
  writeFileSync(join(source, "router.ts"), "export function route() {}\n");
  execFileSync("git", ["-C", source, "add", "."], { env });
  execFileSync("git", ["-C", source, "commit", "-q", "-m", "first"], { env });

  for (const key of ["a", "b"] as const) {
    const machine = machines[key];
    machine.home = join(dir, `home-${key}`);
    machine.repo = join(dir, `clone-${key}`);
    execFileSync("git", ["clone", "-q", source, machine.repo], { env });
    mkdirSync(machine.home);
    writeFileSync(
      join(machine.home, "config.toml"),
      `[proxy]\nport = ${await freePort()}\n\n[store]\nembeddings = "off"\n\n[team]\nsync_interval = 1\n\n[machine]\nname = "machine-${key}"\n`,
    );
  }
  writeFileSync(
    join(machines.a.home, "config.toml"),
    `[proxy]\nport = ${await freePort()}\n\n[store]\nembeddings = "off"\n\n[team]\nurl = "${teamUrl}"\nsync_interval = 1\n\n[machine]\nname = "machine-a"\n`,
  );
  writeFileSync(join(machines.a.home, "team-token"), `${SETUP_TOKEN}\n`, { mode: 0o600 });

  // Machine B takes routine runs whatever it is doing, with a stand-in for Claude Code that answers at once.
  machines.b.bin = join(dir, "bin-b");
  mkdirSync(machines.b.bin);
  writeFileSync(join(machines.b.bin, "claude"), `#!/bin/sh\necho '{"result":"Bumped hono to 4.12."}'\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(machines.b.home, "config.toml"),
    `[proxy]\nport = ${await freePort()}\n\n[store]\nembeddings = "off"\n\n[team]\nsync_interval = 1\n\n[machine]\nname = "machine-b"\nroutines = true\nidle_minutes = 0\nplugged_in = false\ncpu_max = 1\nmemory_max = 1\n`,
  );
}, 120_000);

afterAll(async () => {
  for (const machine of Object.values(machines)) await grenier(machine, "stop").catch(() => {});
  await mf?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("a team of two machines", () => {
  it("lets machine B join from an invite link once A confirms the code B shows", async () => {
    const invited = (await grenier(machines.a, "team", "invite", "bob")).stdout.split("\n");
    const link = (invited[1] ?? "").replace(/^grenier:\/\/join\/[^/]+/, `grenier://join/${new URL(teamUrl).host}`);
    const joining = spawn(BINARY, ["team", "join", link], {
      cwd: machines.b.repo,
      env: { PATH: process.env.PATH, GRENIER_HOME: machines.b.home },
    });
    let said = "";
    joining.stderr.on("data", (chunk: Buffer) => {
      said += chunk.toString();
    });
    let out = "";
    joining.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no code shown: ${said}`)), 20_000);
      const check = setInterval(() => {
        const found = /Your code: (\d{3}) (\d{3})/.exec(said);
        if (found) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(`${found[1]}${found[2]}`);
        }
      }, 100);
    });
    expect((await grenier(machines.a, "team", "confirm", code)).stdout).toContain("bob joined, on machine-b");
    const exit = await new Promise<number | null>((resolve) => joining.on("close", resolve));
    expect(exit).toBe(0);
    expect(out).toContain("as bob (member), on machine-b");
    expect((await grenier(machines.b, "team", "status")).stdout).toContain(`as bob (member) on machine-b`);
  }, 60_000);

  it("makes an answer recorded on machine A a hit on machine B within seconds", async () => {
    await grenier(machines.a, "start");
    await grenier(machines.b, "start");
    const question = "Where are requests routed?";
    await tool(machines.a, "remember", {
      kind: "answer",
      title: question,
      body: "route() in router.ts.",
      files: ["router.ts"],
    });
    const recordedAt = Date.now();

    let result: Record<string, unknown> = {};
    while (Date.now() - recordedAt < 30_000) {
      result = await tool(machines.b, "recall", { query: question });
      if (result.status === "hit") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(result).toMatchObject({ status: "hit", results: [{ title: question, author: "ada" }] });
    expect(Date.now() - recordedAt).toBeLessThan(30_000);
  }, 60_000);

  it("runs a request filed on machine A on machine B, once B's person approved the routine", async () => {
    const file = join(dir, "update.md");
    writeFileSync(file, "---\ntitle: Update dependencies\ntrigger: request\n---\nUpdate the dependencies.\n");
    const added = (await grenier(machines.a, "routines", "add", file)).stdout;
    const id = /\(([0-9A-Za-z_-]+)\)/.exec(added)?.[1] as string;
    expect(id).toBeTruthy();

    const deadline = Date.now() + 30_000;
    while (!(await grenier(machines.b, "routines", "list")).stdout.includes(id)) {
      if (Date.now() > deadline) throw new Error("the routine never reached machine B");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect((await grenier(machines.b, "routines", "approve", id)).stdout).toContain("Approved Update dependencies");

    const client = (await grenier(machines.a, "clients", "add", "e2e", "--scope", "*")).stdout;
    machines.a.token = /Its token \(shown once\): (\S+)/.exec(client)?.[1] as string;
    const filed = await tool(machines.a, "request", { routine: "Update dependencies", title: "Bump hono" });
    let fields: Record<string, unknown> = {};
    while (Date.now() < deadline + 30_000) {
      const found = (await tool(machines.a, "query", { id: String(filed.id) })) as {
        records?: { fields: Record<string, unknown> }[];
      };
      fields = found.records?.[0]?.fields ?? {};
      if (fields.status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(fields).toMatchObject({ status: "done", result: "Bumped hono to 4.12.", machine: "machine-b" });
  }, 90_000);

  it("lists both members and their machines", async () => {
    const members = (await grenier(machines.a, "team", "members")).stdout;
    expect(members).toMatch(/^ada\s+admin\s+ada-mbp/m);
    expect(members).toMatch(/^bob\s+member\s+machine-b/m);
  });
});
