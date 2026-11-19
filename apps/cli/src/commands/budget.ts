import { parseArgs } from "node:util";
import { money } from "@grenier/core";
import type { BudgetScope } from "@grenier/store";
import { environment, type Io, UsageError, withStore } from "../io.ts";

/** A dollar amount, or "off" to remove the limit. */
function amount(flag: string, value: string): number | null {
  if (value === "off") return null;
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`${flag} takes an amount in dollars, such as 10 or 2.5, or "off", not "${value}"`);
  }
  return parsed;
}

/**
 * `grenier budget` shows the limits; `grenier budget set --daily <n> --session <n> [--repo <name>=<n>]` changes them.
 * The daemon reads them at every request, so a change needs no restart.
 */
export async function budget(argv: string[], io: Io): Promise<string[]> {
  const [action, ...rest] = argv;
  const { paths, config } = environment(io);

  if (action === "set") {
    const { values } = parseArgs({
      args: rest,
      strict: true,
      options: {
        daily: { type: "string" },
        session: { type: "string" },
        repo: { type: "string", multiple: true },
      },
    });
    const changes: { scope: BudgetScope; key: string; limit: number | null }[] = [];
    if (values.daily !== undefined) changes.push({ scope: "daily", key: "", limit: amount("--daily", values.daily) });
    if (values.session !== undefined) {
      changes.push({ scope: "session", key: "", limit: amount("--session", values.session) });
    }
    for (const entry of values.repo ?? []) {
      const split = entry.lastIndexOf("=");
      if (split <= 0) throw new UsageError(`--repo takes <name>=<amount>, such as --repo app=2, not "${entry}"`);
      changes.push({ scope: "repo", key: entry.slice(0, split), limit: amount("--repo", entry.slice(split + 1)) });
    }
    if (changes.length === 0) throw new UsageError("budget set needs --daily, --session or --repo");

    await withStore(paths, async (store) => {
      for (const change of changes) {
        if (change.limit === null) await store.budgets.remove(change.scope, change.key);
        else await store.budgets.set(change.scope, change.key, change.limit);
      }
    });
  } else if (action !== undefined) {
    throw new UsageError(`unknown budget action "${action}"; use: grenier budget set …`);
  }

  const stored = await withStore(paths, (store) => store.budgets.list());
  const find = (scope: string, key = "") => stored.find((b) => b.scope === scope && b.key === key)?.limitAmount;
  const line = (label: string, limit: number | undefined, per: string) =>
    `${label.padEnd(16)}${limit === undefined ? "no limit" : `${money(limit)} a ${per}`}`;
  return [
    line("daily", find("daily") ?? config.budgets.daily, "day"),
    line("session", find("session") ?? config.budgets.session, "session"),
    ...stored.filter((b) => b.scope === "repo").map((b) => line(`repo ${b.key}`, b.limitAmount, "day")),
  ];
}
