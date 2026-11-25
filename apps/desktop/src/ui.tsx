import { Copy, type LucideIcon, Plus, Search, Trash } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
          <h1 className="font-mono text-xl leading-[1.2] font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 max-w-[68ch] text-muted">{intro}</p>
        </div>
        {action}
      </header>
      {children}
    </>
  );
}

/** The heading a Section gets: one level below a Part's. */
const Level = createContext<"h2" | "h3">("h2");

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
          <h2 className="font-mono text-lg leading-[1.35] font-semibold">{title}</h2>
          {intro && <p className="mt-1 max-w-[68ch] text-muted">{intro}</p>}
        </div>
        {action}
      </header>
      <Level value="h3">{children}</Level>
    </section>
  );
}

/** A titled block of a Page or a Part, such as a table under its name. */
export function Section({
  title,
  intro,
  action,
  children,
}: {
  title: ReactNode;
  intro?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const Heading = useContext(Level);
  return (
    <section className="mb-7">
      <header className="mb-2.5 flex items-center justify-between gap-4">
        <div>
          <Heading className="label">{title}</Heading>
          {intro && <p className="mt-0.5 text-sm text-muted">{intro}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

type Tone = "plain" | "accent" | "soft" | "problem";

const TONES: Record<Tone, string> = {
  plain: "border-line bg-panel",
  accent: "border-line bg-panel shadow-[inset_2px_0_0_var(--accent)]",
  soft: "border-line bg-accent-soft shadow-[inset_2px_0_0_var(--accent)]",
  problem: "border-danger/50 bg-panel shadow-[inset_2px_0_0_var(--danger)]",
};

/** A raised panel's frame: accent for something to act on, soft for something asking you, or a problem. */
export const panel = (tone: Tone = "plain") => `rounded-lg border ${TONES[tone]}`;

/** Lines, not boxes: a plain block sits on the page under a line; only a tone raises it into a panel. */
const sectionBlock = "border-t border-line pt-4";

export function Card({ tone, className = "", ...props }: ComponentProps<"section"> & { tone?: Tone }) {
  const look = tone && tone !== "plain" ? `${panel(tone)} px-5 py-4` : sectionBlock;
  return <section className={`mb-6 ${look} ${className}`} {...props} />;
}

/** A form's fields, one under another unless `className` gives it columns, under a line. */
export function FormCard({ className = "", ...props }: ComponentProps<"form">) {
  return <form className={`mb-6 grid gap-3 ${sectionBlock} ${className}`} {...props} />;
}

/** A row of buttons, as under a form. */
export function Actions({ className = "", ...props }: ComponentProps<"div">) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`} {...props} />;
}

/** A form behind a button, as an admin adds a skill or an app: `button` opens it, `done` closes it. */
export function useAdding(label: string): { open: boolean; done: () => void; button: ReactNode } {
  const [open, setOpen] = useState(false);
  const done = useCallback(() => setOpen(false), []);
  return {
    open,
    done,
    button: (
      <Button quiet icon={Plus} onClick={() => setOpen(true)}>
        {label}
      </Button>
    ),
  };
}

/** Fields and their buttons on one line, aligned at the bottom. */
export function InlineForm({ className = "", ...props }: ComponentProps<"form">) {
  return <form className={`flex flex-wrap items-end gap-2 ${className}`} {...props} />;
}

/** Sends the words typed only when its button is pressed; `busy` while that search runs. */
export function SearchBox({
  label,
  placeholder,
  busy,
  disabled = false,
  onSearch,
  className = "",
}: {
  label: string;
  placeholder: string;
  busy: boolean;
  disabled?: boolean;
  onSearch: (words: string) => void;
  className?: string;
}) {
  return (
    <InlineForm
      role="search"
      className={`max-w-150 ${className}`}
      onSubmit={(event) => {
        event.preventDefault();
        const words = String(new FormData(event.currentTarget).get("q") ?? "").trim();
        if (words) onSearch(words);
      }}
    >
      <Input
        name="q"
        type="search"
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        className="flex-1"
      />
      <Button type="submit" icon={Search} disabled={busy || disabled}>
        {busy ? "Searching…" : "Search"}
      </Button>
    </InlineForm>
  );
}

/** A key or a link shown once, to copy; where the clipboard refuses, it is selected for the keyboard. */
export function Secret({
  value,
  note,
  copy = "Copy",
  className = "",
  children,
}: {
  value: string;
  note?: ReactNode;
  copy?: string;
  className?: string;
  /** More buttons beside Copy. */
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState<{ value: string; done: boolean } | null>(null);
  const text = useRef<HTMLElement>(null);
  const done = copied?.value === value ? copied.done : null;
  const write = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied({ value, done: true });
    } catch {
      const selection = getSelection();
      if (!text.current || !selection) return setCopied({ value, done: false });
      selection.selectAllChildren(text.current);
      setCopied({ value, done: document.execCommand("copy") });
    }
  };
  return (
    <div className={`grid gap-3 ${className}`}>
      {note && <p>{note}</p>}
      <code ref={text} className="block border border-line bg-bg px-3 py-2.5 break-all whitespace-normal select-all">
        {value}
      </code>
      <Actions>
        <Button icon={Copy} onClick={() => void write()}>
          {done ? "Copied" : copy}
        </Button>
        {children}
        {done === false && <span className="text-sm text-muted">It is selected: press ⌘C or Ctrl+C to copy it.</span>}
      </Actions>
    </div>
  );
}

/** Entries between two lines, a line between each. */
export function List({ className = "", ...props }: ComponentProps<"ul">) {
  return <ul className={`border-y border-line ${className}`} {...props} />;
}

/** One entry of a List: its name, what is known of it, its buttons, and what it unfolds below. */
export function Row({
  title,
  meta,
  actions,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="border-t border-line px-3 py-2 first:border-t-0 hover:bg-hover">
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0">
          <span className="font-semibold">{title}</span>
          {meta && <span className="block font-mono text-xs text-muted">{meta}</span>}
        </span>
        {actions}
      </div>
      {children}
    </li>
  );
}

/** A small label in a table cell, such as a scope. */
export function Tag({ className = "", ...props }: ComponentProps<"span">) {
  return (
    <span
      className={`inline-flex h-4.5 items-center rounded-sm bg-hover px-1.5 font-mono text-2xs font-medium tracking-label text-muted uppercase ${className}`}
      {...props}
    />
  );
}

const STATUS = {
  ok: ["OK", "border-success text-success bg-success/12"],
  warn: ["WARN", "border-warning text-warning bg-warning/12"],
  err: ["ERR", "border-danger text-danger bg-danger/12"],
  info: ["INFO", "border-info text-info bg-info/12"],
} as const;

/** A status word, so a state never rests on colour alone. */
export function Status({ kind }: { kind: keyof typeof STATUS }) {
  const [word, look] = STATUS[kind];
  return (
    <span
      className={`inline-flex h-4.5 shrink-0 items-center rounded-sm border px-1.5 font-mono text-2xs font-medium tracking-label ${look}`}
    >
      {word}
    </span>
  );
}

/** Buttons of which one is pressed, to pick how something shows. */
export function Toggle<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="inline-flex w-fit overflow-hidden rounded-md border border-line-strong bg-panel font-mono text-xs font-medium">
      <legend className="sr-only">{label}</legend>
      {options.map(([key, name]) => (
        <button
          type="button"
          key={key}
          aria-pressed={value === key}
          className={`h-7 cursor-pointer border-l border-line px-2.5 first-of-type:border-l-0 ${value === key ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover hover:text-fg"}`}
          onClick={() => onChange(key)}
        >
          {name}
        </button>
      ))}
    </fieldset>
  );
}

/** An action's outcome: a problem stays on the page until the next action, a success is a toast. */
export function Notice({ message }: { message: Message | string | null }) {
  const toast = useToast();
  const success = message && typeof message !== "string" && !message.problem ? message : null;
  useEffect(() => {
    if (success) toast(success.text);
  }, [success, toast]);
  if (!message || success) return null;
  const text = typeof message === "string" ? message : message.text;
  return (
    <p
      className="mb-4 flex items-start gap-2.5 rounded-md border border-line bg-panel px-3 py-2.5 text-sm shadow-[inset_2px_0_0_var(--danger)]"
      role="alert"
    >
      <Status kind="err" />
      <span>{text}</span>
    </p>
  );
}

interface Toast {
  id: number;
  text: string;
}

const Toasts = createContext<(text: string) => void>(() => {});

/** Shows a success briefly in the corner, above the status bar. */
export const useToast = () => useContext(Toasts);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const push = useCallback((text: string) => {
    next.current += 1;
    const id = next.current;
    setToasts((all) => [...all.slice(-2), { id, text }]);
    setTimeout(() => setToasts((all) => all.filter((toast) => toast.id !== id)), 4000);
  }, []);
  return (
    <Toasts value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-10 z-(--layer-toast) flex flex-col items-end gap-2">
        {toasts.map((toast) => (
          <p
            key={toast.id}
            role="status"
            className="pointer-events-auto flex max-w-105 animate-[appear_0.24s_both] items-center gap-2.5 rounded-lg border border-line-strong bg-panel px-3 py-2.5 text-sm shadow-(--shadow-popover)"
          >
            <Status kind="ok" />
            {toast.text}
          </p>
        ))}
      </div>
    </Toasts>
  );
}

/** A person, as their initials in ink: a circle, so it is never mistaken for an agent or a machine. */
export function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      className="inline-grid shrink-0 place-items-center rounded-full bg-hover font-mono font-semibold text-muted"
    >
      {initials}
    </span>
  );
}

const PRESENCE: Record<string, string> = {
  available: "bg-success",
  busy: "bg-accent shadow-[0_0_6px_var(--accent)]",
  away: "bg-subtle",
};

/** A machine's or a person's state as a dot, with the state's name for the tooltip and screen readers. */
export function Presence({ state }: { state: string }) {
  return (
    <span title={state} className="inline-flex">
      <span aria-hidden="true" className={`size-2 rounded-full ${PRESENCE[state] ?? "border border-line-strong"}`} />
      <span className="sr-only">{state}</span>
    </span>
  );
}

/** A key of a shortcut, as on the keyboard. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-4 min-w-4 place-items-center rounded-sm border border-b-2 border-line-strong bg-bg px-1 font-mono text-2xs leading-none font-medium text-muted">
      {children}
    </kbd>
  );
}

/** A modal decision: the page behind is dimmed and inert until it is answered. */
export function Dialog({
  title,
  label,
  children,
  actions,
  onClose,
}: {
  title: string;
  label?: string;
  children?: ReactNode;
  actions: ReactNode;
  onClose: () => void;
}) {
  const heading = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => previous?.focus();
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-(--layer-dialog) grid place-items-center bg-void/70 p-6">
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        className="chamfer-tl w-110 max-w-full border border-line-strong bg-panel shadow-(--shadow-dialog)"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key !== "Tab" || !box.current) return;
          const focusable = [...box.current.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]")];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="px-5 pt-5 pb-2">
          {label && <p className="label mb-1.5">{label}</p>}
          <h2 id={heading} className="font-mono text-xl leading-[1.2] font-semibold tracking-tight">
            {title}
          </h2>
        </header>
        {children && <div className="px-5 text-muted">{children}</div>}
        <Actions className="justify-end px-5 pt-4 pb-5">{actions}</Actions>
      </div>
    </div>,
    document.body,
  );
}

/** Styles every `title` in the app as the system's tooltip: shown after a pause, at once on keyboard focus. */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let owner: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      if (owner?.dataset.tip) {
        owner.setAttribute("title", owner.dataset.tip);
        delete owner.dataset.tip;
      }
      owner = null;
      setTip(null);
    };
    const show = (event: Event, delay: number) => {
      const element = (event.target as HTMLElement | null)?.closest<HTMLElement>("[title]");
      if (!element || element === owner) return;
      hide();
      const text = element.getAttribute("title") ?? "";
      if (!text) return;
      owner = element;
      element.dataset.tip = text;
      element.removeAttribute("title");
      if (!element.getAttribute("aria-label") && !element.textContent?.trim()) element.setAttribute("aria-label", text);
      timer = setTimeout(() => {
        const box = element.getBoundingClientRect();
        const below = box.top < 40;
        setTip({ text, x: box.left + box.width / 2, y: below ? box.bottom + 6 : box.top - 6, below });
      }, delay);
    };
    const over = (event: Event) => show(event, 500);
    const focus = (event: Event) => {
      if ((event.target as HTMLElement).matches(":focus-visible")) show(event, 0);
    };
    const out = (event: Event) => {
      if (owner && !owner.contains((event as PointerEvent).relatedTarget as Node | null)) hide();
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      hide();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);
  if (!tip) return null;
  return createPortal(
    <div
      role="tooltip"
      style={{ left: tip.x, top: tip.y }}
      className={`pointer-events-none fixed z-(--layer-popover) max-w-70 -translate-x-1/2 animate-[appear_0.12s_both] rounded-sm border border-line-strong bg-void px-2 py-1 text-xs text-fg ${tip.below ? "" : "-translate-y-full"}`}
    >
      {tip.text}
    </div>,
    document.body,
  );
}

/** Shown only when loading takes long enough to notice. */
export function Loading({ what }: { what: string }) {
  return (
    <p className="flex animate-appear items-center gap-2 font-mono text-sm text-muted">
      <span className="size-1.5 rounded-full motion-safe:animate-pulse bg-accent shadow-[0_0_8px_var(--accent)]" />
      Loading {what}…
    </p>
  );
}

/** Grenier's icon (src-tauri/icons/icon.svg), flat: no gradient, glow or frame, for small sizes. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="115" fill="#04050d" />
      <g fill="none" stroke="#fec000" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round">
        <path d="M108 294 L256 166 L404 294" />
        <circle cx="256" cy="320" r="50" fill="#fff4de" stroke="none" />
        <path d="M256 284 V356 M220 320 H292" stroke="#04050d" strokeWidth="12" />
      </g>
    </svg>
  );
}

/** The attic window, Grenier's lit point, for empty states and the status bar. */
export function LitPoint({ size = 48 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      className="drop-shadow-[0_0_10px_var(--accent)]"
    >
      <circle cx="50" cy="50" r="46" className="fill-[color-mix(in_oklab,var(--accent)_25%,white)]" />
      <path d="M50 22 V78 M22 50 H78" stroke="#04050d" strokeWidth="7" strokeLinecap="round" />
    </svg>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-4 rounded-lg border border-dashed border-line-strong bg-[linear-gradient(color-mix(in_oklab,var(--line)_40%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_oklab,var(--line)_40%,transparent)_1px,transparent_1px)] bg-size-[24px_24px] px-5 py-10 text-center text-muted [&_code]:mt-2.5 [&_code]:inline-block [&_code]:px-2.5 [&_code]:py-1 [&_code]:text-fg">
      <LitPoint />
      <div>{children}</div>
    </div>
  );
}

const LOOKS = {
  primary:
    "chamfer text-on-accent enabled:hover:[--chamfer-fill:var(--accent-strong)] enabled:hover:drop-shadow-[0_0_10px_color-mix(in_oklab,var(--accent)_55%,transparent)]",
  quiet: "rounded-md border border-line-strong bg-panel text-fg enabled:hover:bg-hover",
  danger: "rounded-md border border-danger text-danger enabled:hover:bg-danger/12",
  destroy: "rounded-md border border-danger bg-danger text-on-accent enabled:hover:brightness-110",
};

/**
 * Filled with the accent, or quiet. The icon follows the system's rule: `trailing` when it opens options or goes
 * somewhere, `icon` (leading) for a familiar symbol or a button in a group, none otherwise.
 */
export function Button({
  quiet = false,
  danger = false,
  destroy = false,
  square = false,
  icon: Icon,
  trailing: Trailing,
  type = "button",
  className = "",
  children,
  ...props
}: ComponentProps<"button"> & {
  quiet?: boolean;
  danger?: boolean;
  /** Filled with danger: only the answer of a confirmation dialog. */
  destroy?: boolean;
  square?: boolean;
  icon?: LucideIcon | undefined;
  trailing?: LucideIcon | undefined;
}) {
  const look = LOOKS[destroy ? "destroy" : danger ? "danger" : quiet ? "quiet" : "primary"];
  return (
    <button
      type={type}
      className={`inline-flex h-8 cursor-pointer items-center justify-center gap-2 font-mono text-sm font-medium whitespace-nowrap transition-[filter] duration-120 disabled:cursor-default disabled:opacity-55 ${look} ${square ? "w-9 text-lg leading-none" : "px-3"} ${className}`}
      {...props}
    >
      {Icon && <Icon size={14} strokeWidth={1.75} aria-hidden="true" />}
      {children}
      {Trailing && <Trailing size={14} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  );
}

/** Asks in a dialog before an action that can't be undone: the window's own confirm() doesn't wait in the app. */
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
  const removes = /^(remove|delete)\b/i.test(label);
  return (
    <>
      <Button quiet icon={removes ? Trash : undefined} disabled={disabled} onClick={() => setAsking(true)}>
        {removes ? label : `${label}…`}
      </Button>
      {asking && (
        <Dialog
          title={question}
          onClose={() => setAsking(false)}
          actions={
            <>
              <Button quiet data-autofocus onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button
                destroy
                disabled={disabled}
                onClick={() => {
                  setAsking(false);
                  onConfirm();
                }}
              >
                {label}
              </Button>
            </>
          }
        />
      )}
    </>
  );
}

/** Controls reset what a Field's label sets on its text: they read in the content's font and colour. */
const box =
  "rounded-md border border-line-strong bg-panel font-sans text-base font-normal tracking-normal text-fg normal-case hover:border-muted focus-visible:border-accent";
const control = `h-8 ${box}`;

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return <input className={`${control} w-full px-2.5 placeholder:text-subtle ${className}`} {...props} />;
}

/** `className` gives its height; `mono` is for Markdown and code. */
export function Textarea({ mono = false, className = "", ...props }: ComponentProps<"textarea"> & { mono?: boolean }) {
  return (
    <textarea
      className={`${box} w-full px-2.5 py-2 leading-relaxed placeholder:text-subtle ${mono ? "font-mono text-sm" : ""} ${className}`}
      {...props}
    />
  );
}

/** A checkbox with its name, and under it what it means; `className` goes to the label, the rest to the box. */
export function Checkbox({
  label,
  hint,
  className = "",
  ...props
}: Omit<ComponentProps<"input">, "type"> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className={`flex cursor-pointer items-start gap-2.5 ${className}`}>
      <input type="checkbox" className="mt-1 size-3.5 accent-accent" {...props} />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="mt-0.5 block text-sm text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return (
    <select
      className={`${control} cursor-pointer appearance-none bg-(image:--chevron) bg-position-[right_11px_center] bg-no-repeat pr-7.5 pl-2.5 ${className}`}
      {...props}
    />
  );
}

/** A field's name: mono and quiet, in sentence case, as some names are whole sentences. */
const fieldLabel = "flex flex-col gap-1.5 font-mono text-xs font-medium text-muted";

export function Field({ className = "", children }: { className?: string; children: ReactNode }) {
  // biome-ignore lint/a11y/noLabelWithoutControl: the children hold the field's name and its control
  return <label className={`${fieldLabel} ${className}`}>{children}</label>;
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto border-y border-line">
      <table className="w-full">{children}</table>
    </div>
  );
}

/** A row of figures; `className` gives its columns and the top below it. */
export function Figures({ className, children }: { className: string; children: ReactNode }) {
  return <dl className={`grid ${panel()} ${className}`}>{children}</dl>;
}

export function Figure({ value, label, title }: { value: ReactNode; label: string; title?: string }) {
  return (
    <div
      title={title}
      className="flex flex-col-reverse justify-end gap-1 border-l border-line px-4 py-3.5 first:border-l-0 max-lg:nth-3:border-l-0 max-lg:nth-[n+3]:border-t"
    >
      <dd className="font-mono text-2xl font-semibold tabular-nums">{value}</dd>
      <dt className="label">{label}</dt>
    </div>
  );
}
