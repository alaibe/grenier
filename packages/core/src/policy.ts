import type { Config } from "./config.ts";

/** JSON with object keys sorted at every level, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

/** SHA-256 of the text, in hex. Uses Web Crypto, so it runs on Node and on Workers. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Watches one session's tool calls. `observe` returns true when a hash reaches `threshold` occurrences within the
 * last `window` observations, once per streak: it fires again only after that hash has dropped below the threshold.
 */
export class LoopDetector {
  readonly #recent: string[] = [];
  readonly #flagged = new Set<string>();

  constructor(
    readonly threshold: number,
    readonly window: number,
  ) {}

  observe(hash: string): boolean {
    this.#recent.push(hash);
    if (this.#recent.length > this.window) this.#recent.shift();

    for (const flagged of this.#flagged) {
      if (this.count(flagged) < this.threshold) this.#flagged.delete(flagged);
    }
    if (this.count(hash) >= this.threshold && !this.#flagged.has(hash)) {
      this.#flagged.add(hash);
      return true;
    }
    return false;
  }

  count(hash: string): number {
    return this.#recent.filter((seen) => seen === hash).length;
  }
}

export interface BudgetLimit {
  scope: "daily" | "session" | "repo";
  /** The repository's name for a repo limit, "" otherwise. */
  key: string;
  limit: number;
}

/** Limits set with `grenier budget set` win over the config file's. */
export function effectiveLimits(
  configured: Config["budgets"],
  stored: readonly { scope: string; key: string; limitAmount: number }[],
  repoName: string | null,
): BudgetLimit[] {
  const find = (scope: string, key: string) =>
    stored.find((budget) => budget.scope === scope && budget.key === key)?.limitAmount;

  const limits: BudgetLimit[] = [];
  const daily = find("daily", "") ?? configured.daily;
  if (daily !== undefined) limits.push({ scope: "daily", key: "", limit: daily });
  const session = find("session", "") ?? configured.session;
  if (session !== undefined) limits.push({ scope: "session", key: "", limit: session });
  const repo = repoName === null ? undefined : find("repo", repoName);
  if (repo !== undefined && repoName !== null) limits.push({ scope: "repo", key: repoName, limit: repo });
  return limits;
}

export interface BudgetBreach extends BudgetLimit {
  spent: number;
}

/** The first limit that `spent` has reached, or null. A limit is reached once spending equals it. */
export function firstBreach(
  limits: readonly BudgetLimit[],
  spent: (limit: BudgetLimit) => number,
): BudgetBreach | null {
  for (const limit of limits) {
    const amount = spent(limit);
    if (amount >= limit.limit) return { ...limit, spent: amount };
  }
  return null;
}

/** The message an agent shows when a budget stops it: the limit, what was spent, and the command to change it. */
export function budgetMessage(breach: BudgetBreach): string {
  const money = (amount: number) => `$${amount.toFixed(2)}`;
  const what = {
    daily: `the daily budget of ${money(breach.limit)}`,
    session: `this session's budget of ${money(breach.limit)}`,
    repo: `the daily budget of ${money(breach.limit)} for ${breach.key}`,
  }[breach.scope];
  const flag = {
    daily: "--daily <amount>",
    session: "--session <amount>",
    repo: `--repo ${breach.key}=<amount>`,
  }[breach.scope];
  return `Grenier stopped this request: ${what} is reached (${money(breach.spent)} spent). To change it, run: grenier budget set ${flag}`;
}
