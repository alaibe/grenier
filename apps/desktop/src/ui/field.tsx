import { ChevronDown, Search } from "lucide-react";
import { type ComponentProps, createContext, type ReactNode, useContext, useId } from "react";
import { Keys } from "./keycap.tsx";
import type { Shortcut } from "./keys.ts";

interface FieldIds {
  id: string;
  describedBy: string | undefined;
}

const FieldContext = createContext<FieldIds | null>(null);

/** Up to three words, a label is the mono label role; longer ones stay in sentence case (input.md#anatomy). */
const labelClass = (label: string) => (label.trim().split(/\s+/).length > 3 ? "label label-long" : "label");

/** A label above its control, then the help that says what to type (components/input.md). */
export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  const id = useId();
  const below = help ? `${id}-below` : undefined;
  return (
    <div className="field">
      <label className={labelClass(label)} htmlFor={id}>
        {label}
      </label>
      <FieldContext value={{ id, describedBy: below }}>{children}</FieldContext>
      {help && (
        <p className="field-help" id={below}>
          {help}
        </p>
      )}
    </div>
  );
}

function useField() {
  const field = useContext(FieldContext);
  return field ? { id: field.id, "aria-describedby": field.describedBy } : {};
}

type Plain<T extends "input" | "textarea" | "select"> = Omit<ComponentProps<T>, "className" | "style">;

/** `mono` for what is code, an ID, a key, a path or an amount. */
export function Input({ mono = false, ...props }: Plain<"input"> & { mono?: boolean }) {
  return <input className={mono ? "input input-mono" : "input"} {...useField()} {...props} />;
}

/**
 * An item's name, typed where it reads: the item name's type with no box, the focus ring while it has focus. The
 * system has no component for it; `aria-label` names it, as it has no label above.
 */
export function TitleInput(props: Omit<Plain<"input">, "type"> & { "aria-label": string }) {
  return <input className="title-input" type="text" {...props} />;
}

export function Textarea({ mono = false, ...props }: Plain<"textarea"> & { mono?: boolean }) {
  return <textarea className={mono ? "input input-mono" : "input"} {...useField()} {...props} />;
}

/** A native select in the input's look, its chevron drawn in the text's colour. */
export function Select(props: Plain<"select">) {
  return (
    <span className="relative block">
      <select className="input cursor-pointer appearance-none pr-8" {...useField()} {...props} />
      <ChevronDown
        className="icon pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted"
        aria-hidden="true"
      />
    </span>
  );
}

/**
 * The search field: its icon, its key, Esc to clear then leave. `live` filters as you type (↓ moves into the
 * results); otherwise Enter sends the words.
 */
export function SearchField({
  label,
  keys = "/",
  live = false,
  onKeyDown,
  ...props
}: Omit<Plain<"input">, "type" | "aria-label"> & { label: string; keys?: Shortcut; live?: boolean }) {
  return (
    <div className="search">
      <Search className="icon" aria-hidden="true" />
      <input
        className="input"
        type="search"
        aria-label={label}
        data-search={live ? "live" : "submit"}
        autoComplete="off"
        spellCheck={false}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || event.key !== "Escape" || !event.currentTarget.value) return;
          // The first Esc clears the words; the next one leaves the field.
          event.preventDefault();
          const input = event.currentTarget;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(input, "");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }}
        {...props}
      />
      <Keys shortcut={keys} />
    </div>
  );
}
