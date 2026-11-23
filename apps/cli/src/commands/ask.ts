import { parseArgs } from "node:util";
import { MAX_QUESTION, repoSpace } from "@grenier/core";
import { type Embedder, type RecallResult, recall, StoreUseError } from "@grenier/index";
import { embedderLoader, gitFiles, repoResolver } from "../exploration.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";
import { ensureBaseSpaces, identity } from "../runtime.ts";

/** How close a prompt must be to a recorded question for the prompt hook to pass its answer on. */
export const PROMPT_SIMILAR = 0.6;

/** The person at the terminal reads every space this machine has. */
const PERSON = { id: "cli", name: "cli", scopes: ["*"] };

function asText(result: RecallResult): string {
  const [best, ...others] = result.results;
  if (!best) return "Nothing is recorded for this question yet.";
  const lines = [best.body, "", `${best.type}${best.kind ? ` (${best.kind})` : ""}: ${best.title}`];
  const files = best.anchors.map((anchor) => anchor.ref);
  if (files.length > 0) lines.push(`From: ${files.join(", ")}`);
  lines.push(`By ${best.author}, in ${best.space}. Id: ${best.id} (grenier store retire ${best.id} retires it)`);
  if (best.status === "stale") {
    lines.unshift(
      `Stale: ${best.changed.join(", ")} changed since it was written; re-read them before relying on it.`,
      "",
    );
  } else if (best.status === "unchecked") {
    lines.unshift("Unchecked: it came from outside items or another machine's repository.", "");
  }
  if (others.length > 0) lines.push("", "Also close:", ...others.map((other) => `  ${other.id}  ${other.title}`));
  return lines.join("\n");
}

/** `grenier ask [--repo <path>] [--json] <question>`: what the store holds for a question. */
export async function ask(argv: string[], io: Io): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: { repo: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const question = positionals.join(" ").trim();
  if (question === "") throw new UsageError("ask takes a question, as in: grenier ask how are requests routed");
  const { paths, config } = environment(io);
  try {
    const repo = await repoResolver(io.cwd)(values.repo);
    const embedder = await embedderLoader(config, paths, io.err)();
    const result = await withStore(paths, async (store) => {
      await ensureBaseSpaces(store);
      const me = await identity(store, config);
      return recall({ store, embedder, files: gitFiles, me }, PERSON, { query: question, repo, count: false });
    });
    return values.json ? JSON.stringify(result, null, 2) : asText(result);
  } catch (error) {
    if (error instanceof StoreUseError) throw new CommandError(error.message);
    throw error;
  }
}

/**
 * `grenier hook prompt`: Claude Code's UserPromptSubmit hook. When the prompt is close to a question the store holds
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
    if (!repo) return 0;
    const question = input.prompt.slice(0, MAX_QUESTION);
    const result = await withStore(paths, async (store) => {
      const me = await identity(store, config);
      return recall({ store, embedder: vectors, files: gitFiles, me }, PERSON, {
        query: question,
        repo,
        space: repoSpace(repo.id),
        type: "Memory",
        count: false,
        limit: 1,
      });
    });
    const best = result.results[0];
    if (best?.status !== "hit" || (best.similarity ?? 0) < PROMPT_SIMILAR) return 0;
    const context = [
      "Grenier's store holds an answer recorded for a question close to this prompt, and none of the files it was worked out from has changed since.",
      `Question: ${best.title}`,
      `Answer: ${best.body}`,
      `Files: ${best.anchors.map((anchor) => anchor.ref).join(", ")}`,
      "If it covers what you need, use it instead of exploring those files again; recall looks up other questions.",
    ].join("\n");
    io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
  } catch {
    // Nothing: the prompt goes on as if there were no hook.
  }
  return 0;
}
