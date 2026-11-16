import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface BenchRepo {
  name: string;
  url: string;
  commit: string;
  questions: string[];
}

export interface RunUsage {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cost: number;
}

export interface QuestionResult {
  repo: string;
  question: string;
  cold: RunUsage;
  warm: RunUsage;
}

export interface BenchOptions {
  repos: readonly BenchRepo[];
  /** Clones and Grenier's own home go here. */
  workDir: string;
  /** How to run grenier: [node, path to the built grenier.js]. */
  grenier: string[];
  /** The agent's command for one question, given the MCP config file to load. */
  agent: (question: string, mcpConfig: string) => string[];
  port: number;
  /** Where the proxy sends requests; the real API unless a test stands in. */
  upstream?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** The default agent: Claude Code with only Grenier's MCP server and read-only tools, answering in one shot. */
export function claudeAgent(question: string, mcpConfig: string): string[] {
  return [
    "claude",
    "-p",
    question,
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__grenier__ask_codebase,mcp__grenier__record_answer,mcp__grenier__file_summary,mcp__grenier__repo_map,Read,Grep,Glob,LS",
  ];
}

/** An agent command from a template such as `my-agent --ask {question} --mcp {mcp}`. */
export function templateAgent(template: string): (question: string, mcpConfig: string) => string[] {
  const parts = template.split(" ").filter(Boolean);
  return (question, mcpConfig) =>
    parts.map((part) => part.replaceAll("{question}", question).replaceAll("{mcp}", mcpConfig));
}

/** The session id `grenier run` prints on stderr. */
export function sessionIdFrom(stderr: string): string | null {
  return /grenier: session (\S+),/.exec(stderr)?.[1] ?? null;
}

const zero = (): RunUsage => ({ inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0 });

/** Clones each repository at its commit, then asks every question cold and warm. */
export async function runBenchmark(options: BenchOptions): Promise<QuestionResult[]> {
  const log = options.log ?? (() => {});
  const home = join(options.workDir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.toml"),
    `[proxy]\nport = ${options.port}\n${options.upstream ? `upstream_anthropic = ${JSON.stringify(options.upstream)}\n` : ""}`,
  );
  const env = { ...process.env, ...options.env, GRENIER_HOME: home };
  const [node = process.execPath, ...script] = options.grenier;
  const grenier = (args: string[], cwd: string) =>
    exec(node, [...script, ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024 });

  const mcpConfig = join(options.workDir, "mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: { grenier: { command: node, args: [...script, "mcp", "serve"], env: { GRENIER_HOME: home } } },
    }),
  );

  const results: QuestionResult[] = [];
  try {
    for (const repo of options.repos) {
      const dir = join(options.workDir, "repos", repo.name);
      if (!existsSync(dir)) {
        log(`Cloning ${repo.url} at ${repo.commit.slice(0, 10)}`);
        await exec("git", ["clone", "--quiet", repo.url, dir]);
      }
      await exec("git", ["-C", dir, "checkout", "--quiet", "--force", repo.commit]);
      await exec("git", ["-C", dir, "clean", "--quiet", "-fdx"]);
      await grenier(["cache", "clear", "--repo", dir], dir);

      const sessions: Record<"cold" | "warm", (string | null)[]> = { cold: [], warm: [] };
      for (const phase of ["cold", "warm"] as const) {
        for (const question of repo.questions) {
          log(`${repo.name} ${phase}: ${question}`);
          const [command = "", ...args] = options.agent(question, mcpConfig);
          const run = await grenier(["run", "--", command, ...args], dir).catch((error: { stderr?: string }) => ({
            stderr: error.stderr ?? "",
          }));
          sessions[phase].push(sessionIdFrom(run.stderr));
        }
      }

      const report = JSON.parse(
        (await grenier(["report", "--by", "session", "--since", "1d", "--json"], dir)).stdout,
      ) as ({
        key: string;
      } & RunUsage)[];
      const usageOf = (id: string | null): RunUsage => {
        const row = report.find((entry) => entry.key === id);
        return row
          ? {
              inputTokens: row.inputTokens,
              cacheWriteTokens: row.cacheWriteTokens,
              cacheReadTokens: row.cacheReadTokens,
              outputTokens: row.outputTokens,
              cost: row.cost,
            }
          : zero();
      };
      repo.questions.forEach((question, index) => {
        results.push({
          repo: repo.name,
          question,
          cold: usageOf(sessions.cold[index] ?? null),
          warm: usageOf(sessions.warm[index] ?? null),
        });
      });
    }
  } finally {
    await grenier(["stop"], options.workDir).catch(() => {});
  }
  return results;
}

function total(usage: RunUsage): number {
  return usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens + usage.outputTokens;
}

function saving(cold: number, warm: number): string {
  return cold === 0 ? "–" : `${Math.round(((cold - warm) / cold) * 100)}%`;
}

/** The results as a Markdown table: tokens and cost per question, cold and warm, with totals. */
export function formatResults(results: readonly QuestionResult[], meta: { date: string; agent: string }): string {
  const sum = (pick: (result: QuestionResult) => RunUsage): RunUsage =>
    results.reduce<RunUsage>((acc, result) => {
      const usage = pick(result);
      return {
        inputTokens: acc.inputTokens + usage.inputTokens,
        cacheWriteTokens: acc.cacheWriteTokens + usage.cacheWriteTokens,
        cacheReadTokens: acc.cacheReadTokens + usage.cacheReadTokens,
        outputTokens: acc.outputTokens + usage.outputTokens,
        cost: acc.cost + usage.cost,
      };
    }, zero());
  const row = (label: string, question: string, cold: RunUsage, warm: RunUsage) =>
    `| ${label} | ${question} | ${total(cold).toLocaleString("en")} | $${cold.cost.toFixed(4)} | ${total(warm).toLocaleString("en")} | $${warm.cost.toFixed(4)} | ${saving(cold.cost, warm.cost)} |`;
  const cold = sum((result) => result.cold);
  const warm = sum((result) => result.warm);
  return [
    `# Benchmark, ${meta.date}`,
    "",
    `Agent: ${meta.agent}. Each question ran once with Grenier's cache empty (cold) and once after the cold runs had recorded their answers (warm), through the proxy. Tokens count input, cache writes, cache reads and output.`,
    "",
    "| Repository | Question | Cold tokens | Cold cost | Warm tokens | Warm cost | Saved |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...results.map((result) => row(result.repo, result.question, result.cold, result.warm)),
    row("**Total**", "", cold, warm),
    "",
  ].join("\n");
}
