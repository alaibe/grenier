import {
  askCodebase,
  type CacheDeps,
  CacheError,
  type Embedder,
  fileSummary,
  type Repo,
  type RepoFiles,
  recordAnswer,
  recordSummary,
  repoMap,
} from "@grenier/index";
import type { Store } from "@grenier/store";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const INSTRUCTIONS = `Grenier keeps what agents have already worked out about this codebase.
Before exploring code to answer a question about how something works (reading files, searching), call ask_codebase with the question.
- status "hit": an answer recorded earlier whose source files are unchanged. Use it instead of exploring.
- status "stale": the files listed in "changed" were edited since. Re-read only those, then record the answer again.
- status "miss": nothing recorded yet. Explore as usual.
After working out how something works, call record_answer with the question, a concise answer, and every file you read for it.
record_summary keeps a short summary of a file or directory as it is now; file_summary and repo_map read summaries back.`;

export interface McpDeps {
  store: Store;
  files: RepoFiles;
  /** Loads the embedder on first use; null when embeddings are off or unavailable. */
  embedder: () => Promise<Embedder | null>;
  /** The repository for a tool call: the `repo` argument (a path), or the server's own when it has one. */
  resolveRepo: (repo: string | undefined) => Promise<Repo>;
  version: string;
  author?: string;
}

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function answer(work: () => Promise<object>): Promise<ToolResult> {
  try {
    const value = await work();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: { ...value } };
  } catch (error) {
    if (error instanceof CacheError) return { content: [{ type: "text", text: error.message }], isError: true };
    throw error;
  }
}

const repo = z.string().optional().describe("Path to the repository, when it is not the one the agent runs in");

/** The MCP server with the exploration cache's tools. A new one per connection. */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "grenier", version: deps.version }, { instructions: INSTRUCTIONS });
  const cacheDeps = async (): Promise<CacheDeps> => ({
    store: deps.store,
    files: deps.files,
    embedder: await deps.embedder(),
    ...(deps.author ? { author: deps.author } : {}),
  });

  server.registerTool(
    "ask_codebase",
    {
      description:
        "Look up what is already known about how this codebase works before exploring it. Returns hit, stale (with the files changed since) or miss.",
      inputSchema: { question: z.string().min(1).describe("The question, in plain words"), repo },
    },
    async (input) =>
      answer(async () =>
        askCodebase(await cacheDeps(), await deps.resolveRepo(input.repo), { question: input.question }),
      ),
  );

  server.registerTool(
    "record_answer",
    {
      description:
        "Keep an answer about how the codebase works, with the files it was worked out from, so later sessions reuse it until those files change.",
      inputSchema: {
        question: z.string().min(1),
        answer: z.string().min(1).describe("Concise: where things are and how they fit, not a copy of the code"),
        files: z
          .array(z.string())
          .min(1)
          .describe("Every file read to work out the answer, relative to the repository"),
        repo,
      },
    },
    async (input) =>
      answer(async () =>
        recordAnswer(await cacheDeps(), await deps.resolveRepo(input.repo), {
          question: input.question,
          answer: input.answer,
          files: input.files,
        }),
      ),
  );

  server.registerTool(
    "file_summary",
    {
      description: "The summary recorded for a file or directory, if its content has not changed since.",
      inputSchema: { path: z.string().min(1), repo },
    },
    async (input) => answer(async () => fileSummary(await cacheDeps(), await deps.resolveRepo(input.repo), input)),
  );

  server.registerTool(
    "record_summary",
    {
      description:
        "Keep a short summary of a file or directory as it is now (at most a short snippet of code). file_summary and repo_map return it until the content changes.",
      inputSchema: { path: z.string().min(1), summary: z.string().min(1), repo },
    },
    async (input) =>
      answer(async () =>
        recordSummary(await cacheDeps(), await deps.resolveRepo(input.repo), {
          path: input.path,
          summary: input.summary,
        }),
      ),
  );

  server.registerTool(
    "repo_map",
    {
      description: "The repository's top-level modules with the summaries recorded for them.",
      inputSchema: { repo },
    },
    async (input) => answer(async () => repoMap(await cacheDeps(), await deps.resolveRepo(input.repo))),
  );

  return server;
}
