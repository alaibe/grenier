import { type Env, TeamStore } from "./team.ts";
import { WEB } from "./web.ts";

export { TeamStore };

/** Every route goes to the team's one store, except the web view's page itself. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/web")) {
      return new Response(WEB, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
        },
      });
    }
    return env.TEAM.get(env.TEAM.idFromName("team")).fetch(request);
  },
} satisfies ExportedHandler<Env>;
