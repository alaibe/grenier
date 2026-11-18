import { parseArgs } from "node:util";
import { MAX_QUESTION } from "@grenier/core";
import { type AskResult, askCodebase, CacheError, type Embedder } from "@grenier/index";
import { embedderLoader, gitFiles, repoResolver } from "../exploration.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";

/** How close a prompt must be to a recorded question for the prompt hook to pass its answer on. */
export const PROMPT_SIMILAR = 0.6;

function asText(result: AskResult): string {
  if (result.status === "miss") return "Nothing is recorded for this question yet.";
  const lines = [result.answer ?? ""];
  lines.push(
    "",
    `Recorded for: ${result.question}`,
    `From: ${result.sources.map((source) => source.path).join(", ")}`,
    `Id: ${result.id} (grenier cache forget ${result.id} removes it)`,
  );
  if (result.status === "stale") {
    lines.unshift(
      `Stale: ${result.changed.join(", ")} changed since it was recorded; re-read them before relying on it.`,
      "",
    );
  }
  return lines.join("\n");
}

/** `grenier ask [--repo <path>] [--json] <question>`: what the exploration cache holds for a question. */
export async function ask(argv: string[], io: Io): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: { repo: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const question = positionals.join(" ").trim();
  if (question === "") throw new UsageError("ask takes a question, as in: grenier ask how are budgets checked");
  const { paths, config } = environment(io);
  try {
    const repo = await repoResolver(io.cwd)(values.repo);
    const embedder = await embedderLoader(config, paths, io.err)();
    const result = await withStore(paths, (store) =>
      askCodebase({ store, embedder, files: gitFiles }, repo, { question }),
    );
    return values.json ? JSON.stringify(result, null, 2) : asText(result);
  } catch (error) {
    if (error instanceof CacheError) throw new CommandError(error.message);
    throw error;
  }
}

/**
 * `grenier hook prompt`: Claude Code's UserPromptSubmit hook. When the prompt is close to a question the cache holds
 * an unchanged answer for, passes that answer to the agent as context. It never stands in the prompt's way: any
 * failure, or no strong match, prints nothing. It looks without counting a reuse, and never downloads the model.
 * Tests pass their own `embedder`.
 */
export async function promptHook(io: Io, embedder?: Embedder | null): Promise<number> {
  try {
    const input = JSON.parse((await io.stdin?.()) ?? "") as { prompt?: unknown; cwd?: unknown };
    if (typeof input.prompt !== "string" || typeof input.cwd !== "string" || input.prompt.trim() === "") return 0;
    const { paths, config } = environment(io);
    const vectors =
      embedder === undefined ? await embedderLoader(config, paths, () => {}, { offline: true })() : embedder;
    if (!vectors) return 0;
    const repo = await repoResolver(input.cwd)(undefined);
    const question = input.prompt.slice(0, MAX_QUESTION);
    const result = await withStore(paths, (store) =>
      askCodebase({ store, embedder: vectors, files: gitFiles }, repo, { question, count: false }),
    );
    if (result.status !== "hit" || (result.similarity ?? 0) < PROMPT_SIMILAR) return 0;
    const context = [
      "Grenier's exploration cache holds an answer recorded for a question close to this prompt, and none of the files it was worked out from has changed since.",
      `Question: ${result.question}`,
      `Answer: ${result.answer}`,
      `Files: ${result.sources.map((source) => source.path).join(", ")}`,
      "If it covers what you need, use it instead of exploring those files again; ask_codebase looks up other questions.",
    ].join("\n");
    io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
  } catch {
    // Nothing: the prompt goes on as if there were no hook.
  }
  return 0;
}
