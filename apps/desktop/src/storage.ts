/** What this window kept under a key, as JSON; the fallback when there is none, or storage is off. */
export function stored<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    return text === null ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
}

/** Keeps a value under a key for the next time the app opens; nothing when storage is off. */
export function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
