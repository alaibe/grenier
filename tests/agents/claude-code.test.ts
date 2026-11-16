// Claude Code itself through the daemon, against a stand-in for the API: run by hand with `pnpm test:agents` where
// `claude` is installed. It uses a dummy API key and a throwaway config directory, so no real login or key is sent,
// and nothing reaches Anthropic.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, messageStream } from "../support/anthropic.ts";

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
    const port = await freePort();
    await grenier("status");
    writeFileSync(
      join(dir, ".grenier", "config.toml"),
      `[proxy]\nport = ${port}\nupstream_anthropic = "http://127.0.0.1:${(upstream.address() as AddressInfo).port}"\n`,
    );
    expect((await grenier("start")).code).toBe(0);
  });

  afterAll(async () => {
    await grenier("stop");
    await new Promise((resolve) => upstream?.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("works unchanged: the answer comes back and the usage is recorded", async () => {
    const run = await grenier("run", "--", claude as string, "-p", "Reply with one word.");
    expect(run.stdout.trim()).toBe("pong");
    expect(messages.length).toBeGreaterThan(0);
    const report = await grenier("report", "--by", "session");
    expect(report.stdout).toMatch(/^total\s+\d+/m);
  }, 120_000);

  it("shows the budget error and does not retry it", async () => {
    await grenier("budget", "set", "--daily", "0");
    const before = messages.length;
    const run = await grenier("run", "--", claude as string, "-p", "Reply with one word.");
    await grenier("budget", "set", "--daily", "off");

    expect(run.code).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain("grenier budget set --daily");
    expect(messages.length).toBe(before);

    const db = join(dir, ".grenier", "grenier.db");
    const blocked = execFileSync("sqlite3", [db, "SELECT count(*) FROM events WHERE kind = 'budget'"], {
      encoding: "utf8",
    }).trim();
    // One blocked request per call Claude Code makes, not a retry loop.
    expect(Number(blocked)).toBeLessThanOrEqual(2);
  }, 120_000);
});
