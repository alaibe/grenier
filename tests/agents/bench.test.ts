// Run by hand with `pnpm test:agents`: a stand-in for the API plays the model, so nothing reaches Anthropic.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "@grenier/core/node";
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
  system?: unknown;
  tools?: { name: string }[];
  messages?: { role: string; content: string | Content[] }[];
}

const ASK = "mcp__grenier__recall";
const RECORD = "mcp__grenier__remember";
/** Input tokens of the call made once ToolSearch has loaded Grenier's tools: small next to the prompt. */
const LOADED = 500;

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

/** Claude Code defers MCP tools: it names them in the prompt, and the model loads them with ToolSearch. */
function next(request: Request): [Block, number] {
  const loaded = request.tools?.some((tool) => tool.name === ASK) ?? false;
  const deferred = !loaded && JSON.stringify([request.system, request.messages]).includes(ASK);
  if (!loaded && !deferred) return [{ type: "text", text: "ok" }, 25];
  const ask: [Block, number] = [
    { type: "tool_use", id: `toolu_ask_${toolResults.length}`, name: ASK, input: { query: QUESTION } },
    20_000,
  ];
  const load: [Block, number] = [
    {
      type: "tool_use",
      id: `toolu_search_${toolResults.length}`,
      name: "ToolSearch",
      input: { query: `select:${ASK},${RECORD}`, max_results: 5 },
    },
    20_000,
  ];
  const messages = request.messages ?? [];
  // Claude Code may follow the tool results with a system message, and merges consecutive turns into one.
  const last = messages.findLast((message) => message.role !== "system")?.content;
  const result = Array.isArray(last) ? last.findLast((block) => block.type === "tool_result") : undefined;
  if (!result) return loaded ? ask : load;
  const call = messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block.type === "tool_use" && block.id === result.tool_use_id);
  const name = call?.name ?? "unknown";
  if (name === "ToolSearch") {
    return loaded ? [ask[0], LOADED] : [{ type: "text", text: "ToolSearch did not load the tools" }, 25];
  }
  const text = textOf(result.content);
  toolResults.push({ name, text });
  if (name === ASK && !/"status":\s*"hit"/.test(text)) {
    return [
      {
        type: "tool_use",
        id: `toolu_record_${toolResults.length}`,
        name: RECORD,
        input: { kind: "answer", title: QUESTION, body: ANSWER, files: ["app.ts"] },
      },
      20_000,
    ];
  }
  return [{ type: "text", text: ANSWER }, name === ASK ? 2_000 : 20_000];
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
    const models = resolvePaths({ GRENIER_HOME: join(dir, "work", "home") }).models;
    if (existsSync(MODELS)) cpSync(MODELS, models, { recursive: true });

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

    expect(toolResults.map((result) => result.name)).toEqual([ASK, RECORD, ASK]);
    expect(toolResults[0]?.text).toMatch(/"status":\s*"miss"/);
    expect(toolResults[2]?.text).toMatch(/"status":\s*"hit"/);
    expect(toolResults[2]?.text).toContain(ANSWER);

    const [result] = results;
    // Cold: ToolSearch, ask, record, answer; warm: ToolSearch, ask, answer; plus Claude Code's toolless side requests.
    expect(result?.cold.inputTokens).toBeGreaterThanOrEqual(60_000);
    expect(result?.warm.inputTokens).toBeGreaterThanOrEqual(22_000);
    expect(result?.warm.inputTokens).toBeLessThan(23_000);
    expect(result?.warm.cost).toBeLessThan(result?.cold.cost ?? 0);
  }, 300_000);
});
