import { createMcpServer } from "@grenier/gateway";
import { gitFiles } from "@grenier/git";
import { readerFor } from "@grenier/index";
import { openSqliteStore } from "@grenier/store/sqlite";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version } from "../../package.json";
import { agentTexts } from "../agent-texts.ts";
import { environment, type Io } from "../io.ts";
import { embedderLoader, ensureBaseTops, identity, repoResolver } from "../runtime.ts";

/** `grenier mcp serve`: the MCP server over stdio, for an agent that launches it in its working directory. */
export async function serve(io: Io): Promise<number> {
  const { paths, config } = environment(io);
  const store = openSqliteStore(paths.db);
  await ensureBaseTops(store);
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
