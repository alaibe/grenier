import { createMcpServer, startingPages } from "@grenier/gateway";
import { gitFiles } from "@grenier/git";
import { readerFor } from "@grenier/index";
import { openSqliteStore } from "@grenier/store/sqlite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version } from "../../package.json";
import { agentTexts } from "../agent-texts.ts";
import { CLAUDE_CODE, whereOf } from "../agents/index.ts";
import { environment, type Io, withStore } from "../io.ts";
import { embedderLoader, identity, repoResolver } from "../runtime.ts";

/** `grenier mcp serve`: the MCP server over stdio, for an agent that launches it in its working directory. */
export async function serve(io: Io): Promise<number> {
  const { paths, config } = environment(io);
  const store = openSqliteStore(paths.db);
  const server = createMcpServer({
    store,
    files: gitFiles,
    embedder: embedderLoader(config, paths, io.err),
    resolveRepo: repoResolver(io.cwd),
    // The client token the app wrote into the agent's config when it added Grenier, looked up at each call.
    reader: () => readerFor(store, io.env.GRENIER_CLIENT_TOKEN),
    me: () => identity(store, config),
    version,
    texts: () => agentTexts(paths.home),
    ...(io.env.GRENIER_SESSION ? { sessionId: io.env.GRENIER_SESSION } : {}),
    ...(io.env.GRENIER_RUN_TOP ? { runTop: io.env.GRENIER_RUN_TOP } : {}),
  });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
    process.stdin.once("end", resolve);
  });
  await server.connect(transport);
  await closed;
  await server.close();
  await store.close();
  return 0;
}

/** `grenier mcp context`: Claude Code's SessionStart hook; a failure leaves the session as it would have been. */
export async function context(io: Io): Promise<number> {
  try {
    const { paths, config } = environment(io);
    // The token Claude Code's config gives Grenier's server.
    const env = CLAUDE_CODE.servers(whereOf(io)).grenier?.env as Record<string, unknown> | undefined;
    const token = env?.GRENIER_CLIENT_TOKEN;
    if (typeof token !== "string") return 0;
    const pages = await withStore(paths, async (store) =>
      startingPages(
        { store, files: gitFiles, embedder: null, me: await identity(store, config) },
        await readerFor(store, token),
      ),
    );
    const folders = pages.map(({ folder, records }) => ({
      folder,
      pages: records.map(({ id, title, body }) => ({ id, title, body })),
    }));
    const text = `Grenier gives you the folders ${folders.map(({ folder }) => folder).join(", ")} to start with, as get gives them: work by them, and don't get them again. ${pages[0]?.notice ?? ""}\n\n${JSON.stringify(folders)}`;
    io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
  } catch (error) {
    io.err(`grenier: ${(error as Error).message}`);
  }
  return 0;
}
