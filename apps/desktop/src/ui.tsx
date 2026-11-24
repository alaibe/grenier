import { type ComponentProps, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api.ts";

/** Dollars with cents, or with the two digits that matter below ten cents, as the CLI writes them. */
export const money = (amount: number) =>
  amount === 0 || Math.abs(amount) >= 0.1 ? `$${amount.toFixed(2)}` : `$${Number(amount.toPrecision(2))}`;
export const count = (value: number) => value.toLocaleString("en");

export const times = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

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

/** Runs one action at a time; its message or error stays on the page until the next action. */
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
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-4xl leading-[1.2] font-semibold">{title}</h1>
          <p className="mt-1.5 max-w-[60ch] text-muted">{intro}</p>
        </div>
        {action}
      </header>
      {children}
    </>
  );
}

/** One part of a screen under its own heading, as Settings holds several. */
export function Part({
  title,
  intro,
  action,
  children,
}: {
  title: string;
  intro?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-12">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-serif text-2xl leading-[1.2] font-semibold">{title}</h2>
          {intro && <p className="mt-1 max-w-[60ch] text-muted">{intro}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Notice({ message }: { message: Message | string | null }) {
  if (!message) return null;
  const { text, problem } = typeof message === "string" ? { text: message, problem: true } : message;
  return problem ? (
    <p className="mb-4 rounded-lg border border-problem bg-problem-soft px-3.5 py-2.5 text-problem" role="alert">
      {text}
    </p>
  ) : (
    <p className="mb-4 rounded-lg border border-line bg-panel px-3.5 py-2.5" role="status">
      {text}
    </p>
  );
}

/** Shown only when loading takes long enough to notice. */
export function Loading({ what }: { what: string }) {
  return <p className="animate-appear text-muted">Loading {what}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-5 py-7 text-center text-muted [&_code]:mt-2.5 [&_code]:inline-block [&_code]:px-2.5 [&_code]:py-1 [&_code]:text-fg">
      {children}
    </div>
  );
}

/** Filled with the accent, or quiet; a square one holds a single glyph. */
export function Button({
  quiet = false,
  square = false,
  type = "button",
  className = "",
  ...props
}: ComponentProps<"button"> & { quiet?: boolean; square?: boolean }) {
  const look = quiet
    ? "border-line-strong bg-panel text-fg enabled:hover:bg-hover"
    : "border-accent bg-accent text-accent-fg";
  return (
    <button
      type={type}
      className={`h-8 cursor-pointer rounded-md border font-medium whitespace-nowrap disabled:cursor-default disabled:opacity-55 ${look} ${square ? "w-9 text-xl leading-none" : "px-3.5"} ${className}`}
      {...props}
    />
  );
}

/** Asks in the page: the window's own confirm() does not wait for an answer in the app. */
export function ConfirmButton({
  label,
  question,
  onConfirm,
  disabled = false,
}: {
  label: string;
  question: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) yes.current?.focus();
  }, [asking]);
  if (!asking) {
    return (
      <Button quiet disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <fieldset className="inline-flex items-center gap-1.5">
      <legend className="sr-only">{question}</legend>
      <span className="text-sm text-muted" aria-hidden="true">
        {question}
      </span>
      <Button
        ref={yes}
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        Yes, {label.toLowerCase()}
      </Button>
      <Button quiet onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </fieldset>
  );
}

const control = "h-8.5 rounded-md border border-line-strong bg-panel font-normal";

export function Input(props: ComponentProps<"input">) {
  return <input className={`${control} w-full px-2.5 placeholder:text-muted placeholder:opacity-80`} {...props} />;
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return (
    <select
      className={`${control} cursor-pointer appearance-none bg-(image:--chevron) bg-position-[right_11px_center] bg-no-repeat pr-7.5 pl-2.5 ${className}`}
      {...props}
    />
  );
}

export function Field({ children }: { children: ReactNode }) {
  // biome-ignore lint/a11y/noLabelWithoutControl: the children hold the field's name and its control
  return <label className="flex flex-col gap-1.5 text-md font-medium">{children}</label>;
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <table className="w-full">{children}</table>
    </div>
  );
}

/** A row of figures; `className` gives its columns and the top below it. */
export function Figures({ className, children }: { className: string; children: ReactNode }) {
  return <dl className={`grid rounded-xl border border-line bg-panel ${className}`}>{children}</dl>;
}

export function Figure({ value, label, title }: { value: ReactNode; label: string; title?: string }) {
  return (
    <div
      title={title}
      className="border-l border-line px-4 py-3.5 first:border-l-0 max-lg:nth-3:border-l-0 max-lg:nth-[n+3]:border-t"
    >
      <dd className="text-3xl font-semibold tabular-nums">{value}</dd>
      <dt className="text-sm leading-[1.35] text-muted">{label}</dt>
    </div>
  );
}
