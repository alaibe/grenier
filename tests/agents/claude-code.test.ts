// Run by hand with `pnpm test:agents`: a dummy key and a throwaway config directory, so nothing reaches Anthropic.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, messageStream } from "../support/anthropic.ts";
import { startDaemon } from "../support/daemon.ts";

const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));
const claude = (() => {
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();

let dir: string;
let upstream: Server;
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
let port: number;
const messages: string[] = [];

const env = () => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GRENIER_HOME: join(dir, ".grenier"),
  CLAUDE_CONFIG_DIR: join(dir, ".claude"),
  ANTHROPIC_API_KEY: "sk-ant-stand-in-key",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
});

async function grenier(...args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)(BINARY, args, { cwd: dir, env: env(), timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe.skipIf(claude === null)("Claude Code through grenier run", () => {
  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-claude-")));
    upstream = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const path = request.url ?? "";
        if (path.startsWith("/v1/messages/count_tokens")) {
          response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":25}');
        } else if (path.startsWith("/v1/messages")) {
          messages.push(path);
          const model = (JSON.parse(body || "{}") as { model?: string }).model ?? "claude-opus-5-5";
          response
            .writeHead(200, { "content-type": "text/event-stream" })
            .end(messageStream(model, { type: "text", text: "pong" }));
        } else {
          response
            .writeHead(404, { "content-type": "application/json" })
            .end('{"type":"error","error":{"type":"not_found_error","message":"not here"}}');
        }
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    port = await freePort();
    mkdirSync(join(dir, ".grenier"), { recursive: true });
    writeFileSync(
      join(dir, ".grenier", "config.toml"),
      `[proxy]\nport = ${port}\nupstream_anthropic = "http://127.0.0.1:${(upstream.address() as AddressInfo).port}"\n`,
    );
    daemon = await startDaemon(BINARY, env(), dir);
  });

  afterAll(async () => {
    await daemon?.stop();
    await new Promise((resolve) => upstream?.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("works unchanged: the answer comes back and the usage is recorded", async () => {
    const run = await grenier("run", "--", claude as string, "-p", "Reply with one word.");
    expect(run.stdout.trim()).toBe("pong");
    expect(messages.length).toBeGreaterThan(0);
    const token = readFileSync(join(dir, ".grenier", "admin-token"), "utf8").trim();
    const overview = (await (
      await fetch(`http://127.0.0.1:${port}/admin/overview`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { sessions: { requests: number }[] };
    expect(overview.sessions[0]?.requests).toBeGreaterThan(0);
  }, 120_000);
});
