import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type BenchRepo, claudeAgent, formatResults, runBenchmark, templateAgent } from "./bench.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    port: { type: "string", default: "7789" },
    repos: { type: "string", default: join(root, "repos.json") },
  },
});

const { repos } = JSON.parse(readFileSync(values.repos, "utf8")) as { repos: BenchRepo[] };
const date = new Date().toISOString().slice(0, 10);
const results = await runBenchmark({
  repos,
  workDir: join(root, ".work"),
  grenier: [process.execPath, resolve(root, "../apps/cli/dist/grenier.js")],
  agent: values.agent ? templateAgent(values.agent) : claudeAgent,
  port: Number(values.port),
  log: (line) => process.stderr.write(`${line}\n`),
});

const file = join(root, "results", `${date}.md`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, formatResults(results, { date, agent: values.agent ?? "Claude Code (claude -p)" }));
process.stdout.write(`${file}\n`);
