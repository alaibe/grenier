import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolvePaths } from "@grenier/core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDaemon } from "../support/daemon.ts";

const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));
const STREAM = readFileSync(new URL("../fixtures/anthropic/stream-tool-use.sse", import.meta.url));

let dir: string;
let upstream: Server;
let proxyPort: number;
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
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
  proxyPort = await freePort();

  const paths = resolvePaths({ GRENIER_HOME: join(dir, ".grenier") });
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(
    paths.config,
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
  daemon = await startDaemon(BINARY, { PATH: process.env.PATH, GRENIER_HOME: join(dir, ".grenier") }, dir);
});

afterAll(async () => {
  await daemon?.stop();
  await new Promise((resolve) => upstream.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe("the daemon and grenier run", () => {
  it("streams a response through the proxy byte for byte and records its usage under the session", async () => {
    const run = await grenier("run", "--", process.execPath, "client.mjs", "out.sse");
    expect(run.code).toBe(0);
    const session = /session (\S+),/.exec(run.stderr)?.[1];

    expect(readFileSync(join(dir, "out.sse"))).toEqual(STREAM);
    expect(received.at(-1)).toEqual({ url: "/v1/messages?beta=true", apiKey: "sk-ant-e2e" });

    const token = readFileSync(resolvePaths({ GRENIER_HOME: join(dir, ".grenier") }).adminToken, "utf8").trim();
    const overview = (await (
      await fetch(`http://127.0.0.1:${proxyPort}/admin/overview`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { sessions: { key: string }[] };
    expect(overview.sessions.find((row) => row.key === session)).toMatchObject({
      requests: 1,
      inputTokens: 12,
      cacheWriteTokens: 2048,
      cacheReadTokens: 30_000,
      outputTokens: 87,
    });
  });
});
