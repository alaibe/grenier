import { Hono } from "hono";
import { createProxy, errorResponse, type ProxyOptions, UNTAGGED } from "./proxy.ts";

export interface GatewayOptions extends ProxyOptions {
  /** The port the daemon listens on, to accept only requests addressed to this machine. */
  port: number;
}

/** The daemon's HTTP app: the proxy under /s/<session>/… for `grenier run`, and untagged everywhere else. */
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

  app.all("/s/:session/*", (c) => {
    const session = c.req.param("session");
    const path = new URL(c.req.url).pathname.slice(`/s/${session}`.length) || "/";
    return proxy(c.req.raw, session, path);
  });
  app.all("*", (c) => proxy(c.req.raw, UNTAGGED, new URL(c.req.url).pathname));

  return app;
}
