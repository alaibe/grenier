/** Dollars with cents, or with the two digits that matter below ten cents, as the CLI writes them. */
export const money = (amount: number) =>
  amount === 0 || Math.abs(amount) >= 0.1 ? `$${amount.toFixed(2)}` : `$${Number(amount.toPrecision(2))}`;

export const count = (value: number) => value.toLocaleString("en");

export const times = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

const pad = (n: number) => String(n).padStart(2, "0");

/** A machine date, as the system's voice writes it: 2026-11-24 14:02. */
export function exact(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A time in a list, short and relative: 12s, 4m, 3h, Tue, 24 Nov; in the future, in 3h. */
export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  const elapsed = now - ts;
  const span = Math.abs(elapsed);
  const date = new Date(ts);
  const short =
    span < 60_000
      ? `${Math.max(1, Math.floor(span / 1000))}s`
      : span < 3_600_000
        ? `${Math.floor(span / 60_000)}m`
        : span < 86_400_000
          ? `${Math.floor(span / 3_600_000)}h`
          : span < 6 * 86_400_000
            ? (DAYS[date.getDay()] as string)
            : `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  if (span >= 86_400_000) return short;
  return elapsed >= 0 ? short : `in ${short}`;
}

/** How long ago, said in a sentence: "12s ago", "3h ago", or the day when it is older than one. */
export function since(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  const short = ago(ts, now);
  return now - ts < 86_400_000 && !short.startsWith("in ") ? `${short} ago` : short;
}

/** A report day (YYYY-MM-DD, local) as "Tue 17 Nov". */
export function day(key: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!parts) return key;
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}
