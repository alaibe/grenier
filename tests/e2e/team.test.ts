import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hash, startWorker } from "../support/worker.ts";

const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));

let dir: string;
let mf: Miniflare;
let teamUrl: string;

interface Machine {
  home: string;
  repo: string;
}
const machines: Record<"a" | "b", Machine> = { a: { home: "", repo: "" }, b: { home: "", repo: "" } };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function grenier(machine: Machine, ...args: string[]) {
  return promisify(execFile)(BINARY, args, {
    cwd: machine.repo,
    env: { PATH: process.env.PATH, GRENIER_HOME: machine.home },
  });
}

async function tool(machine: Machine, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: BINARY,
      args: ["mcp", "serve"],
      cwd: machine.repo,
      env: { PATH: process.env.PATH ?? "", GRENIER_HOME: machine.home },
      stderr: "pipe",
    }),
  );
  try {
    return (await client.callTool({ name, arguments: args })).structuredContent as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-e2e-team-")));
  const started = await startWorker({ listen: true });
  mf = started.mf;
  teamUrl = (started.url as URL).origin;
  const db = await mf.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO members (id, name, token_hash, role, created_at) VALUES ('a', 'ada', ?, 'admin', 0), ('b', 'bob', ?, 'member', 0)",
    )
    .bind(hash("gt_ada"), hash("gt_bob"))
    .run();

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

  for (const [key, token] of [
    ["a", "gt_ada"],
    ["b", "gt_bob"],
  ] as const) {
    const machine = machines[key];
    machine.home = join(dir, `home-${key}`);
    machine.repo = join(dir, `clone-${key}`);
    execFileSync("git", ["clone", "-q", source, machine.repo], { env });
    mkdirSync(machine.home);
    writeFileSync(
      join(machine.home, "config.toml"),
      `[proxy]\nport = ${await freePort()}\n\n[cache]\nembeddings = "off"\n\n[team]\nurl = "${teamUrl}"\nsync_interval = 1\n`,
    );
    writeFileSync(join(machine.home, "team-token"), `${token}\n`, { mode: 0o600 });
    await grenier(machine, "team", "share");
    await grenier(machine, "start");
  }
}, 120_000);

afterAll(async () => {
  for (const machine of Object.values(machines)) await grenier(machine, "stop").catch(() => {});
  await mf?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("a team of two machines", () => {
  it("knows who each machine is", async () => {
    expect((await grenier(machines.b, "team", "status")).stdout).toContain(`team      ${teamUrl}, as bob (member)`);
  });

  it("makes an answer recorded on machine A a hit on machine B within one minute", async () => {
    const question = "Where are requests routed?";
    await tool(machines.a, "record_answer", { question, answer: "route() in router.ts.", files: ["router.ts"] });
    const recordedAt = Date.now();

    let result: Record<string, unknown> = {};
    while (Date.now() - recordedAt < 60_000) {
      result = await tool(machines.b, "ask_codebase", { question });
      if (result.status === "hit") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(result).toMatchObject({ status: "hit", answer: "route() in router.ts." });
    expect(Date.now() - recordedAt).toBeLessThan(60_000);
  }, 90_000);

  it("shows the shared answer and both members on the dashboard", async () => {
    const response = await fetch(`${teamUrl}/api/dashboard`, { headers: { authorization: "Bearer gt_ada" } });
    const board = (await response.json()) as { answers: number; members: { name: string }[] };
    expect(board.answers).toBe(1);
    expect(board.members.map((member) => member.name)).toEqual(["ada", "bob"]);
  });
});
