import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatResults, runBenchmark, sessionIdFrom, templateAgent } from "../../bench/src/bench.ts";

const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));

let dir: string;
let upstream: Server;
let served = 0;

function answer(inputTokens: number): string {
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    event("message_start", {
      type: "message_start",
      message: { model: "claude-opus-5-5", usage: { input_tokens: inputTokens, output_tokens: 1 } },
    }) + event("message_delta", { type: "message_delta", usage: { output_tokens: 50 } })
  );
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-e2e-bench-")));
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

  // Each question runs cold then warm: answer the first as if the agent explored, the second as if the cache answered.
  upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      served += 1;
      response.writeHead(200, { "content-type": "text/event-stream" }).end(answer(served % 2 === 1 ? 20_000 : 2_000));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  writeFileSync(
    join(dir, "agent.mjs"),
    `const [question, mcp] = process.argv.slice(2);
    if (!question || !mcp) process.exit(9);
    const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-bench" },
      body: JSON.stringify({ model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: question }] }),
    });
    await response.arrayBuffer();
    if (!response.ok) process.exit(1);`,
  );
});

afterAll(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

async function bench(workDir: string, budget?: number) {
  const free = createServer();
  await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
  const port = (free.address() as AddressInfo).port;
  await new Promise((resolve) => free.close(resolve));
  const commit = execFileSync("git", ["-C", join(dir, "source"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  served = 0;
  return runBenchmark({
    repos: [
      {
        name: "app",
        url: join(dir, "source"),
        commit,
        questions: ["Where is app defined?", "What does app export?"],
      },
    ],
    workDir: join(dir, workDir),
    grenier: [process.execPath, BINARY],
    agent: templateAgent(`${process.execPath} ${join(dir, "agent.mjs")} {question} {mcp}`),
    port,
    upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    env: { PATH: process.env.PATH },
    ...(budget !== undefined ? { budget } : {}),
  });
}

describe("the benchmark", () => {
  it("asks every question cold then warm through the proxy, and tabulates tokens and cost", async () => {
    const results = await bench("work");

    expect(results.map((result) => [result.question, result.cold.inputTokens, result.warm.inputTokens])).toEqual([
      ["Where is app defined?", 20_000, 2_000],
      ["What does app export?", 20_000, 2_000],
    ]);
    expect(results[0]?.cold.cost).toBeCloseTo((20_000 * 4 + 50 * 20) / 1_000_000, 10);

    const table = formatResults(results, { date: "2026-11-16", agent: "test agent" });
    expect(table).toContain("| Repository | Question | Cold tokens | Cold cost | Warm tokens | Warm cost | Saved |");
    expect(table).toContain("| app | Where is app defined? | 20,050 | $0.0810 | 2,050 | $0.0090 | 89% |");
    expect(table).toMatch(/\| \*\*Total\*\* \| {2}\| 40,100 \| \$0\.1620 \| 4,100 \| \$0\.0180 \| 89% \|/);
    expect(JSON.parse(readFileSync(join(dir, "work", "mcp.json"), "utf8")).mcpServers.grenier.args.slice(-2)).toEqual([
      "mcp",
      "serve",
    ]);
  }, 120_000);

  it("asks no further question once its cap is reached, and leaves a run that did not finish out of the table", async () => {
    // A question costs $0.081 cold and $0.009 warm: the first pair passes a $0.05 cap, so the second is not asked.
    const results = await bench("work-capped", 0.05);

    expect(results.map((result) => [result.question, result.complete])).toEqual([["Where is app defined?", true]]);
    const first = results[0] as (typeof results)[number];
    const table = formatResults([first, { ...first, question: "What does app export?", complete: false }], {
      date: "2026-11-16",
      agent: "test agent",
      budget: 0.05,
    });
    expect(table).toContain("The run was capped at $0.05.");
    expect(table).toMatch(/\| \*\*Total\*\* \| {2}\| 20,050 \| \$0\.0810 \| 2,050 \| \$0\.0090 \| 89% \|/);
    expect(table).toContain("Not counted, because a run stopped before the end");
    expect(table).toContain("- app: What does app export?");
  }, 120_000);

  it("reads the session id grenier run prints", () => {
    expect(sessionIdFrom("grenier: session Ab_9-x, through http://127.0.0.1:7789/s/Ab_9-x\n")).toBe("Ab_9-x");
    expect(sessionIdFrom("nothing")).toBeNull();
  });
});
