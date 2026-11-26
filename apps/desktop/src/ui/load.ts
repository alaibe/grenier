import { useCallback, useEffect, useRef, useState } from "react";
import { useWork } from "../activity.tsx";
import { ApiError } from "../api.ts";
import { type ToastInput, useToast } from "./toast.tsx";

const messageOf = (reason: unknown) => (reason instanceof ApiError ? reason.message : String(reason));

/** Loads data for a view, with its error, and a reload for after an action; the status bar pulses while it runs. */
export function useLoad<T>(load: () => Promise<T>): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const work = useWork();
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the reload trigger
  useEffect(() => {
    let current = true;
    const done = work(null);
    load()
      .then((value) => {
        if (current) {
          setData(value);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (current) setError(messageOf(reason));
      })
      .finally(done);
    return () => {
      current = false;
      done();
    };
  }, [load, version, work]);
  return { data, error, reload };
}

/** What an action that worked says: its toast, in the past tense of its button, with Undo when it can be undone. */
export type Outcome = string | ToastInput | undefined;

/**
 * Runs one action at a time. What it did is a toast; a problem stays on the page as `problem` until the next action
 * (patterns/feedback.md). `working` names it in the status bar while it runs: "Syncing".
 */
export function useAction(onDone: () => void = () => {}): {
  run: (key: string, action: () => Promise<Outcome>, working?: string) => Promise<boolean>;
  busy: string | null;
  problem: string | null;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();
  const work = useWork();
  const finished = useRef(onDone);
  finished.current = onDone;
  const run = useCallback(
    async (key: string, action: () => Promise<Outcome>, working?: string) => {
      setBusy(key);
      setProblem(null);
      const done = work(working ?? null);
      try {
        const outcome = await action();
        if (outcome) toast(typeof outcome === "string" ? { text: outcome } : outcome);
        finished.current();
        return true;
      } catch (reason) {
        setProblem(messageOf(reason));
        return false;
      } finally {
        done();
        setBusy(null);
      }
    },
    [toast, work],
  );
  return { run, busy, problem };
}
