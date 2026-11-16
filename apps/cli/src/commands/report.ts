import { parseArgs } from "node:util";
import {
  buildReport,
  cacheReport,
  formatCacheReport,
  formatReport,
  type GroupBy,
  loadPrices,
  parseSince,
} from "@grenier/log";
import { environment, type Io, UsageError, withStore } from "../io.ts";

const GROUPS: readonly GroupBy[] = ["day", "session", "repo"];

/**
 * `grenier report [--by day|session|repo] [--since 7d] [--json]`, or `grenier report --cache` for the prompt cache by
 * session.
 */
export async function report(argv: string[], io: Io, now = Date.now()): Promise<string> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      by: { type: "string", default: "day" },
      since: { type: "string", default: "7d" },
      cache: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const by = values.by as GroupBy;
  if (!GROUPS.includes(by)) throw new UsageError(`--by takes day, session or repo, not "${values.by}"`);
  let since: number;
  try {
    since = parseSince(values.since, now);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  const { paths, config } = environment(io);
  const rows = await withStore(paths, (store) => store.usage.list({ since }));
  if (values.cache) {
    const cache = cacheReport(rows);
    return values.json ? JSON.stringify(cache, null, 2) : formatCacheReport(cache);
  }
  const report = buildReport(rows, by, loadPrices(config.prices));
  return values.json ? JSON.stringify(report, null, 2) : formatReport(report);
}
