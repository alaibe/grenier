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
  /** daily, session and repo limits are this machine's; team and member limits are the team server's, per UTC day. */
  scope: "daily" | "session" | "repo" | "team" | "member";
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
  /** What the request was expected to cost, when that, not what was spent, would pass the limit. */
  next?: number;
}

/**
 * The first limit that `spent` has reached, or that the next request, expected to cost `next`, would pass; null when
 * there is none. A limit is reached once spending equals it.
 */
export function firstBreach(
  limits: readonly BudgetLimit[],
  spent: (limit: BudgetLimit) => number,
  next = 0,
): BudgetBreach | null {
  for (const limit of limits) {
    const amount = spent(limit);
    if (amount >= limit.limit) return { ...limit, spent: amount };
    if (next > 0 && amount + next > limit.limit) return { ...limit, spent: amount, next };
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
    team: `the team's daily budget of ${money(breach.limit)}`,
    member: `your daily budget of ${money(breach.limit)} in the team`,
  }[breach.scope];
  const change = {
    daily: "grenier budget set --daily <amount>",
    session: "grenier budget set --session <amount>",
    repo: `grenier budget set --repo ${breach.key}=<amount>`,
    team: "grenier team budget --team <amount> (a team admin)",
    member: "grenier team budget --member <amount> (a team admin)",
  }[breach.scope];
  const why =
    breach.next === undefined
      ? `${what} is reached (${money(breach.spent)} spent)`
      : `${what} would be passed (${money(breach.spent)} spent, and this session's last request cost ${money(breach.next)})`;
  return `Grenier stopped this request: ${why}. To change it, run: ${change}`;
}

export const MAX_SHARED_TEXT = 4000;
export const MAX_CODE_LINES = 10;
export const MAX_QUESTION = 2000;

/**
 * Rule 4: an answer or summary describes code; it may quote a short snippet, never a file. Null when the text is
 * fine, else what is wrong with it.
 */
export function unshareable(text: string): string | null {
  if (text.trim() === "") return "the text is empty";
  if (text.length > MAX_SHARED_TEXT) return `it holds at most ${MAX_SHARED_TEXT} characters`;
  const blocks = text.split("```").filter((_, index) => index % 2 === 1);
  for (const block of blocks) {
    if (block.trim().split("\n").length > MAX_CODE_LINES + 1) {
      return `it may quote at most ${MAX_CODE_LINES} lines of code at a time`;
    }
  }
  return null;
}

/**
 * The longest run of lines `text` copies from `source`, in order, comparing trimmed lines and skipping blank ones:
 * rule 4's check against the files an answer or summary was worked out from, which catches code quoted without fences.
 */
export function copiedLines(text: string, source: string): number {
  const lines = (value: string) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  const ours = lines(text);
  const theirs = lines(source);
  const at = new Map<string, number[]>();
  for (const [index, line] of theirs.entries()) {
    const found = at.get(line);
    if (found) found.push(index);
    else at.set(line, [index]);
  }
  let longest = 0;
  for (const [index, line] of ours.entries()) {
    for (const start of at.get(line) ?? []) {
      let run = 1;
      while (index + run < ours.length && ours[index + run] === theirs[start + run]) run++;
      longest = Math.max(longest, run);
    }
  }
  return longest;
}

/** ISO 13616: move the first four characters to the end, letters to numbers, and the remainder mod 97 must be 1. */
function validIban(candidate: string): boolean {
  const compact = candidate.replace(/\s+/g, "").toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

// Country code, check digits, then the account in groups of four as IBANs are written (or run together).
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;
// A phone number: an optional + or 00 and country code, then groups of digits, 9 to 15 digits in all.
const PHONE = /(?<![\w+(])(?:\+|00)?\(?\d(?:[\s.\-/]?\(?\d{1,4}\)?){3,8}(?!\w)/g;
const TOWN = "[A-ZÀ-Ý][A-Za-zÀ-ÿ'\\-]+(?:[ \\-][A-ZÀ-Ý][A-Za-zÀ-ÿ'\\-]+){0,2}";
const POSTCODE_TOWN = `(?:,?\\s*\\d{4,5}\\s+${TOWN})?`;
/** The word in either case, letter by letter, so the rest of the pattern can stay case-sensitive. */
const anyCase = (word: string) => word.replace(/[a-zà-ÿ]/g, (c) => `[${c}${c.toUpperCase()}]`);
const STREET_WORDS_FIRST = [
  "rue",
  "avenue",
  "av\\.",
  "boulevard",
  "bd",
  "chemin",
  "place",
  "impasse",
  "allée",
  "allee",
  "quai",
  "route",
  "cours",
  "via",
  "calle",
  "strasse",
  "straße",
];
// "12 rue de la Paix", "3 Hauptstraße": the street word before the name.
const STREET_FIRST = new RegExp(
  `\\b\\d{1,5}(?: ?(?:bis|ter|[a-zA-Z]))?,?\\s+(?:${STREET_WORDS_FIRST.map(anyCase).join("|")})\\b[^\\n,;]{1,50}${POSTCODE_TOWN}`,
  "g",
);
// "221B Baker Street": the street word after the name.
const STREET_LAST = new RegExp(
  `\\b\\d{1,5}[A-Za-z]?\\s+(?:[A-Z][A-Za-z'\\-]*\\s+){1,4}(?:Street|St\\.|Road|Rd\\.|Avenue|Ave\\.|Lane|Ln\\.|Drive|Dr\\.|Way|Court|Ct\\.|Boulevard|Blvd\\.|Place|Terrace|Square)(?![A-Za-z])${POSTCODE_TOWN}`,
  "g",
);

/**
 * Removes IBANs (checked with their mod-97 digits), phone numbers and street addresses from text before it leaves
 * the daemon. Heuristics: an address without a street word, or a phone number written with letters, passes through.
 */
export function redact(text: string): string {
  return text
    .replace(IBAN, (match) => (validIban(match) ? "[IBAN removed]" : match))
    .replace(STREET_FIRST, "[address removed]")
    .replace(STREET_LAST, "[address removed]")
    .replace(PHONE, (match) => {
      const digits = match.replace(/\D/g, "").length;
      return digits >= 9 && digits <= 15 ? "[phone removed]" : match;
    });
}
