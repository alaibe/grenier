import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));
const STREAM = readFileSync(new URL("../fixtures/anthropic/stream-tool-use.sse", import.meta.url));

let dir: string;
let upstream: Server;
const received: { url: string; apiKey: string | undefined }[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function grenier(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(BINARY, args, {
      cwd: dir,
      env: { PATH: process.env.PATH, GRENIER_HOME: join(dir, ".grenier") },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-e2e-proxy-")));
  upstream = createServer((request, response) => {
    received.push({ url: request.url ?? "", apiKey: request.headers["x-api-key"] as string | undefined });
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      // In two parts, as a network would deliver it.
      response.write(STREAM.subarray(0, 200));
      setTimeout(() => response.end(STREAM.subarray(200)), 20);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const proxyPort = await freePort();

  await grenier("status");
  writeFileSync(
    join(dir, ".grenier", "config.toml"),
    `[proxy]\nport = ${proxyPort}\nupstream_anthropic = "http://127.0.0.1:${upstreamPort}"\n`,
  );
  writeFileSync(
    join(dir, "client.mjs"),
    `const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-e2e", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.argv[2], Buffer.from(await response.arrayBuffer()));
    writeFileSync(process.argv[2] + ".status", String(response.status) + " " + (response.headers.get("x-should-retry") ?? ""));
    `,
  );
  expect((await grenier("start")).stdout).toMatch(/^Daemon started \(pid \d+\)\.$/m);
});

afterAll(async () => {
  await grenier("stop");
  await new Promise((resolve) => upstream.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe("the daemon and grenier run", () => {
  it("reports the running daemon", async () => {
    expect((await grenier("status")).stdout).toMatch(/daemon {4}running \(pid \d+, port \d+\)/);
    expect((await grenier("start")).stdout).toMatch(/already running/);
  });

  it("streams a response through the proxy byte for byte and records its usage under the session", async () => {
    const run = await grenier("run", "--", process.execPath, "client.mjs", "out.sse");
    expect(run.code).toBe(0);
    const session = /session (\S+),/.exec(run.stderr)?.[1];

    expect(readFileSync(join(dir, "out.sse"))).toEqual(STREAM);
    expect(received.at(-1)).toEqual({ url: "/v1/messages?beta=true", apiKey: "sk-ant-e2e" });

    const report = await grenier("report", "--by", "session");
    expect(report.stdout).toMatch(new RegExp(`^${session}\\s+1\\s+12\\s+2048\\s+30k\\s+87\\s`, "m"));
  });

  it("passes the command's exit code through", async () => {
    expect((await grenier("run", "--", process.execPath, "-e", "process.exit(4)")).code).toBe(4);
  });

  it("stops", async () => {
    expect((await grenier("stop")).stdout).toMatch(/^Daemon stopped \(pid \d+\)\.$/m);
    expect((await grenier("status")).stdout).toContain("daemon    stopped");
    expect((await grenier("stop")).stdout).toContain("not running");
  });
});
