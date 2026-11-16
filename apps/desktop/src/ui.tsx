import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError } from "./api.ts";

export const money = (amount: number) => `$${amount.toFixed(2)}`;
export const count = (value: number) => value.toLocaleString("en");
export const when = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : "never");

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
        if (current) setError(reason instanceof ApiError ? reason.message : String(reason));
      });
    return () => {
      current = false;
    };
  }, [load, version]);
  return { data, error, reload };
}

/** Runs an action, showing its error in the view instead of losing it. */
export function useAction(onDone: () => void): {
  run: (action: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
  error: string | null;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

export function Problem({ message }: { message: string | null }) {
  return message ? (
    <p className="problem" role="alert">
      {message}
    </p>
  ) : null;
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
