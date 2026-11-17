import { parseArgs } from "node:util";
import { buildReport, formatStatusLine, formatToday, loadPrices, startOfToday, totalOf } from "@grenier/log";
import { environment, type Io, withStore } from "../io.ts";

/** The session `grenier run` gave the agent: GRENIER_SESSION, else the `/s/<session>` in its base URL. */
export function sessionOf(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GRENIER_SESSION) return env.GRENIER_SESSION;
  return /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/s\/([^/]+)/.exec(env.ANTHROPIC_BASE_URL ?? "")?.[1];
}

/**
 * `grenier statusline [--today]`: one line for Claude Code's status line, with what the agent's session and today
 * spent and saved. `--today` prints today's alone, for the desktop app's menu bar.
 */
export async function statusline(argv: string[], io: Io, now = Date.now()): Promise<string> {
  const { values } = parseArgs({ args: argv, strict: true, options: { today: { type: "boolean", default: false } } });
  const { paths, config } = environment(io);
  const prices = loadPrices(config.prices);
  const sessionId = values.today ? undefined : sessionOf(io.env);

  return withStore(paths, async (store) => {
    const today = totalOf(buildReport(await store.usage.list({ since: startOfToday(now) }), "day", prices));
    if (values.today) return formatToday(today);
    const session = sessionId ? totalOf(buildReport(await store.usage.list({ sessionId }), "session", prices)) : null;
    return formatStatusLine(today, session);
  });
}
