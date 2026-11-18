import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError } from "./api.ts";

export const money = (amount: number) => `$${amount.toFixed(2)}`;
export const count = (value: number) => value.toLocaleString("en");

export function moment(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

export function ago(ts: number | null): string {
  if (!ts) return "never";
  const elapsed = Date.now() - ts;
  for (const [unit, size] of STEPS) {
    if (elapsed >= size) return relative.format(-Math.floor(elapsed / size), unit);
  }
  return "just now";
}

/** A report day (YYYY-MM-DD, local) as "Tue 17 Nov". */
export function day(key: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!parts) return key;
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

const messageOf = (reason: unknown) => (reason instanceof ApiError ? reason.message : String(reason));

/** Loads data for a view, with its error, and a reload for after an action. */
export function useLoad<T>(load: () => Promise<T>): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the reload trigger
  useEffect(() => {
    let current = true;
    load()
      .then((value) => {
        if (current) {
          setData(value);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (current) setError(messageOf(reason));
      });
    return () => {
      current = false;
    };
  }, [load, version]);
  return { data, error, reload };
}

export interface Message {
  text: string;
  problem?: boolean;
}

/**
 * Runs one action at a time. `busy` names the running one, so its button can say what it is doing; the action's
 * message, or its error, stays on the page until the next action.
 */
export function useAction(onDone: () => void): {
  run: (key: string, action: () => Promise<Message | undefined>) => Promise<boolean>;
  busy: string | null;
  message: Message | null;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const run = async (key: string, action: () => Promise<Message | undefined>) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage((await action()) ?? null);
      onDone();
      return true;
    } catch (reason) {
      setMessage({ text: messageOf(reason), problem: true });
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { run, busy, message };
}

export function Page({
  title,
  intro,
  action,
  children,
}: {
  title: string;
  intro: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="intro">{intro}</p>
        </div>
        {action}
      </header>
      {children}
    </>
  );
}

export function Notice({ message }: { message: Message | string | null }) {
  if (!message) return null;
  const { text, problem } = typeof message === "string" ? { text: message, problem: true } : message;
  return problem ? (
    <p className="message problem" role="alert">
      {text}
    </p>
  ) : (
    <p className="message" role="status">
      {text}
    </p>
  );
}

/** Shown only when loading takes long enough to notice. */
export function Loading({ what }: { what: string }) {
  return <p className="loading">Loading {what}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
