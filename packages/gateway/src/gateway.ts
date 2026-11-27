import { bearer } from "@grenier/core";
import { readerFor } from "@grenier/index";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { createMcpServer, type McpDeps } from "./mcp.ts";
import { createProxy, errorResponse, type ProxyOptions, UNTAGGED } from "./proxy.ts";

export interface GatewayOptions extends ProxyOptions {
  /** The port the daemon listens on, to accept only requests addressed to this machine. */
  port: number;
  mcp: Omit<McpDeps, "store">;
  /** The daemon's admin API, served under /admin behind the same Host check. */
  admin: Hono;
}

/** MCP at /mcp, the admin API given under /admin, the proxy under /s/<session>/…, and untagged proxying elsewhere. */
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
    const token = bearer(c.req.header("authorization"));
    if (!(await readerFor(options.store, token))) {
      return errorResponse(
        401,
        "authentication_error",
        "Grenier's MCP endpoint needs a client token: Authorization: Bearer <token>.",
      );
    }
    const server = createMcpServer({
      ...options.mcp,
      store: options.store,
      // A token revoked mid-request stops at its next tool call.
      reader: () => readerFor(options.store, token),
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

  app.route("/admin", options.admin);

  app.all("/s/:session/*", (c) => {
    const session = c.req.param("session");
    const path = new URL(c.req.url).pathname.slice(`/s/${session}`.length) || "/";
    return route(c.req.raw, session, path);
  });
  app.all("*", (c) => route(c.req.raw, UNTAGGED, new URL(c.req.url).pathname));

  return app;
}
