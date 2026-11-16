// The benchmark's own Claude Code command against a stand-in for the API: run by hand with `pnpm test:agents` where
// `claude` is installed. The stand-in plays the model and calls Grenier's tools as an agent would, so this checks that
// Claude Code accepts the flags the benchmark passes, loads Grenier's MCP server and runs its tools, and that the cold
// run records what the warm run reuses. A dummy key and a throwaway config directory: nothing reaches Anthropic.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeAgent, runBenchmark } from "../../bench/src/bench.ts";
import { type Block, freePort, messageStream } from "../support/anthropic.ts";

const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));
const MODELS = fileURLToPath(new URL("../../node_modules/.cache/grenier-models", import.meta.url));
const QUESTION = "Where is app defined?";
const ANSWER = "app is defined and exported in app.ts.";
const claude = (() => {
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();

interface Content {
  type: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
}
interface Request {
  model?: string;
  tools?: { name: string }[];
  messages?: { role: string; content: string | Content[] }[];
}

// Settings of a Claude Code session this test may run inside stay out of the one it starts.
const outside = Object.fromEntries(
  Object.keys(process.env)
    .filter((name) => /^(CLAUDE|ANTHROPIC|MCP_)/.test(name))
    .map((name) => [name, undefined]),
);

let dir: string;
let upstream: Server;
const toolResults: { name: string; text: string }[] = [];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("") : "";
}

/** What the stand-in model does next: ask the cache, record on a miss, answer on a hit or once recorded. */
function next(request: Request): [Block, number] {
  if (!request.tools?.some((tool) => tool.name === "mcp__grenier__ask_codebase")) {
    return [{ type: "text", text: "ok" }, 25];
  }
  const messages = request.messages ?? [];
  // Claude Code may follow the tool results with a system message, and merges consecutive turns into one.
  const last = messages.findLast((message) => message.role !== "system")?.content;
  const result = Array.isArray(last) ? last.findLast((block) => block.type === "tool_result") : undefined;
  if (!result) {
    return [
      {
        type: "tool_use",
        id: `toolu_ask_${toolResults.length}`,
        name: "mcp__grenier__ask_codebase",
        input: { question: QUESTION },
      },
      20_000,
    ];
  }
  const call = messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block.type === "tool_use" && block.id === result.tool_use_id);
  const name = call?.name ?? "unknown";
  const text = textOf(result.content);
  toolResults.push({ name, text });
  if (name === "mcp__grenier__ask_codebase" && !/"status":\s*"hit"/.test(text)) {
    return [
      {
        type: "tool_use",
        id: `toolu_record_${toolResults.length}`,
        name: "mcp__grenier__record_answer",
        input: { question: QUESTION, answer: ANSWER, files: ["app.ts"] },
      },
      20_000,
    ];
  }
  return [{ type: "text", text: ANSWER }, name === "mcp__grenier__ask_codebase" ? 2_000 : 20_000];
}

describe.skipIf(claude === null)("the benchmark with Claude Code", () => {
  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-claude-bench-")));
    const source = join(dir, "source");
    mkdirSync(source);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", source, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@x.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@x.invalid",
        },
      }).trim();
    git("init", "-q");
    writeFileSync(join(source, "app.ts"), "export const app = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    if (existsSync(MODELS)) cpSync(MODELS, join(dir, "work", "home", "models"), { recursive: true });

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
          const parsed = JSON.parse(body || "{}") as Request;
          const [block, inputTokens] = next(parsed);
          response
            .writeHead(200, { "content-type": "text/event-stream" })
            .end(messageStream(parsed.model ?? "claude-opus-5-5", block, inputTokens));
        } else {
          response
            .writeHead(404, { "content-type": "application/json" })
            .end('{"type":"error","error":{"type":"not_found_error","message":"not here"}}');
        }
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise((resolve) => upstream?.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("records an answer cold and reuses it warm, through Claude Code's own MCP client", async () => {
    const commit = execFileSync("git", ["-C", join(dir, "source"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const results = await runBenchmark({
      repos: [{ name: "app", url: join(dir, "source"), commit, questions: [QUESTION] }],
      workDir: join(dir, "work"),
      grenier: [process.execPath, BINARY],
      agent: claudeAgent,
      port: await freePort(),
      upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      env: {
        ...outside,
        CLAUDE_CONFIG_DIR: join(dir, ".claude"),
        ANTHROPIC_API_KEY: "sk-ant-stand-in-key",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      },
    });

    expect(toolResults.map((result) => result.name)).toEqual([
      "mcp__grenier__ask_codebase",
      "mcp__grenier__record_answer",
      "mcp__grenier__ask_codebase",
    ]);
    expect(toolResults[0]?.text).toMatch(/"status":\s*"miss"/);
    expect(toolResults[2]?.text).toMatch(/"status":\s*"hit"/);
    expect(toolResults[2]?.text).toContain(ANSWER);

    const [result] = results;
    // Three model calls cold, two warm, and the odd side request Claude Code makes without tools (25 tokens each).
    expect(result?.cold.inputTokens).toBeGreaterThanOrEqual(60_000);
    expect(result?.warm.inputTokens).toBeGreaterThanOrEqual(22_000);
    expect(result?.warm.inputTokens).toBeLessThan(23_000);
    expect(result?.warm.cost).toBeLessThan(result?.cold.cost ?? 0);
  }, 300_000);
});
