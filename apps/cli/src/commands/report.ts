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
import { computeOutcomes, type Effectiveness, effectiveness, LANDING_DAYS } from "../effectiveness.ts";
import { environment, type Io, UsageError, withStore } from "../io.ts";

const GROUPS: readonly GroupBy[] = ["day", "session", "repo"];

/**
 * `grenier report [--by day|session|repo] [--since 7d] [--json]`, `grenier report --cache` for the prompt cache by
 * session, or `grenier report --effectiveness` for what the spend turned into.
 */
export async function report(argv: string[], io: Io, now = Date.now()): Promise<string> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      by: { type: "string", default: "day" },
      since: { type: "string", default: "7d" },
      cache: { type: "boolean", default: false },
      effectiveness: { type: "boolean", default: false },
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
  if (values.effectiveness) {
    const window = argv.some((arg) => arg.startsWith("--since")) ? since : parseSince("30d", now);
    const result = await withStore(paths, async (store) => {
      await computeOutcomes(store, now);
      return effectiveness(store, window, now);
    });
    return values.json ? JSON.stringify(result, null, 2) : formatEffectiveness(result);
  }
  const rows = await withStore(paths, (store) => store.usage.list({ since }));
  if (values.cache) {
    const cache = cacheReport(rows);
    return values.json ? JSON.stringify(cache, null, 2) : formatCacheReport(cache);
  }
  const report = buildReport(rows, by, loadPrices(config.prices));
  return values.json ? JSON.stringify(report, null, 2) : formatReport(report);
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
const dollars = (amount: number) => `$${amount.toFixed(2)}`;

/** What the spend turned into, in words. */
export function formatEffectiveness(result: Effectiveness): string {
  if (result.sessions === 0) {
    return result.pending > 0
      ? `${result.pending} sessions are under ${LANDING_DAYS} days old: their edits have not had time to land yet.`
      : "No session to work out yet: run agents with grenier run in a repository.";
  }
  const lines = [
    `Effectiveness ${percent(result.spend > 0 ? result.effective / result.spend : 0)}: ${dollars(result.effective)} of ${dollars(result.spend)} turned into code that landed or answers agents used.`,
    result.landedShare === null
      ? "Landed share: no edits in these sessions."
      : `Landed share: ${percent(result.landedShare)} of the lines agents wrote are on the default branch ${LANDING_DAYS} days later.`,
    `Rediscovery: ${dollars(result.rediscovery)} spent reading files a recorded answer already covered.`,
  ];
  if (result.perIssue.length > 0) {
    lines.push("", "Cost per issue:");
    for (const issue of result.perIssue.slice(0, 15)) {
      lines.push(`  ${issue.key.padEnd(14)} ${dollars(issue.cost).padStart(9)}  ${issue.sessions} sessions`);
    }
  }
  if (result.pending > 0) {
    lines.push("", `${result.pending} newer sessions are left out until their edits had ${LANDING_DAYS} days.`);
  }
  lines.push("", "These numbers stay on this machine.");
  return lines.join("\n");
}
