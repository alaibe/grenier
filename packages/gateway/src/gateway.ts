import { sha256 } from "@grenier/core";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { createMcpServer, type McpDeps } from "./mcp.ts";
import { createProxy, errorResponse, type ProxyOptions, UNTAGGED } from "./proxy.ts";

export interface GatewayOptions extends ProxyOptions {
  /** The port the daemon listens on, to accept only requests addressed to this machine. */
  port: number;
  /** Serves the MCP tools at /mcp (Streamable HTTP), for clients holding a token. */
  mcp?: Omit<McpDeps, "store">;
}

/**
 * The daemon's HTTP app: MCP at /mcp for clients with a token, the proxy under /s/<session>/… for `grenier run`, and
 * untagged proxying everywhere else.
 */
export function createGateway(options: GatewayOptions): Hono {
  const proxy = createProxy(options);
  const hosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`, `[::1]:${options.port}`]);
  const app = new Hono();

  // A page in a browser can reach 127.0.0.1; refusing other Host values stops DNS rebinding from reading answers.
  app.use(async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!hosts.has(host)) return errorResponse(403, "permission_error", "Grenier only answers requests to 127.0.0.1.");
    return next();
  });

  app.all("/mcp", async (c) => {
    if (!options.mcp) return errorResponse(404, "not_found_error", "MCP is not served here.");
    const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const client = token ? await options.store.clients.findActive(await sha256(token)) : undefined;
    if (!client) {
      return errorResponse(
        401,
        "authentication_error",
        "Grenier's MCP endpoint needs a client token: Authorization: Bearer <token>.",
      );
    }
    const reader = { id: client.id, name: client.name, scopes: client.scopes };
    const server = createMcpServer({
      ...options.mcp,
      store: options.store,
      // A token revoked mid-request stops at its next tool call.
      reader: async () => ((await options.store.clients.findActive(client.tokenHash)) ? reader : null),
    });
    // No session id generator: stateless, one server per request.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  // OpenAI's API lives under /openai/, so one port serves both: …/openai/v1/responses goes to upstream_openai.
  const route = (raw: Request, session: string, path: string) =>
    path.startsWith("/openai/")
      ? proxy(raw, session, path.slice("/openai".length), "openai")
      : proxy(raw, session, path);

  app.all("/s/:session/*", (c) => {
    const session = c.req.param("session");
    const path = new URL(c.req.url).pathname.slice(`/s/${session}`.length) || "/";
    return route(c.req.raw, session, path);
  });
  app.all("*", (c) => route(c.req.raw, UNTAGGED, new URL(c.req.url).pathname));

  return app;
}
