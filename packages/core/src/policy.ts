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

/** Web Crypto, so it runs on Node and on Workers. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Fires once a hash repeats `threshold` times in the last `window`, then forgets those repeats. */
export class LoopDetector {
  #recent: string[] = [];

  constructor(
    readonly threshold: number,
    readonly window: number,
  ) {}

  observe(hash: string): boolean {
    this.#recent.push(hash);
    if (this.#recent.length > this.window) this.#recent.shift();

    if (this.count(hash) < this.threshold) return false;
    this.#recent = this.#recent.filter((seen) => seen !== hash);
    return true;
  }

  count(hash: string): number {
    return this.#recent.filter((seen) => seen === hash).length;
  }
}

export const MAX_SHARED_TEXT = 4000;
export const MAX_CODE_LINES = 10;
export const MAX_QUESTION = 2000;

/** Null when an answer or summary is fine to share, else why: it may quote a short snippet, never a file. */
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

/** The longest run of trimmed, non-blank lines copied in order: catches code quoted without fences. */
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

// A card number as cards print it: 13 to 19 digits run together, groups of four (the last one shorter), or 4-6-5.
const CARD = /(?<![\d-])(?:\d{13,19}|\d{4}(?:([ -])\d{4}){2}\1\d{1,7}|\d{4}([ -])\d{6}\2\d{5})(?![\d-])/g;
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
// Dates, times and IPv4 addresses have the shape of a phone number; they are set aside while PHONE runs.
const KEPT = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
  /\b\d{1,2}[/.]\d{1,2}[/.]\d{4}\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  new RegExp(`(?<![\\d.])${OCTET}(?:\\.${OCTET}){3}(?![.\\d])`, "g"),
];

/** The Luhn checksum card numbers carry, so an order or account number is not taken for one. */
function luhn(digits: string): boolean {
  let total = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    total += digit;
  }
  return total % 10 === 0;
}

/** Removes IBANs, card numbers, phone numbers and street addresses; dates, times and IPv4 addresses stay. */
export function redact(text: string): string {
  // Every pattern below needs a digit.
  if (!/\d/.test(text)) return text;
  const kept: string[] = [];
  let result = text.replace(IBAN, (match) => (validIban(match) ? "[IBAN removed]" : match));
  // Text that holds private-use characters already (icon fonts) is not marked, so no mark can be mistaken for one.
  const marking = !/[\uE000-\uF8FF]/.test(text);
  for (const pattern of marking ? KEPT : []) {
    result = result.replace(pattern, (match) => {
      if (kept.length >= 0x1900) return match;
      kept.push(match);
      return String.fromCharCode(0xe000 + kept.length - 1);
    });
  }
  return result
    .replace(CARD, (match) => (luhn(match.replace(/\D/g, "")) ? "[card removed]" : match))
    .replace(STREET_FIRST, "[address removed]")
    .replace(STREET_LAST, "[address removed]")
    .replace(PHONE, (match) => {
      const digits = match.replace(/\D/g, "").length;
      return digits >= 9 && digits <= 15 ? "[phone removed]" : match;
    })
    .replace(/[\uE000-\uF8FF]/g, (mark) => kept[mark.charCodeAt(0) - 0xe000] ?? mark);
}
