import { Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLayer } from "../shell/commands.tsx";
import type { Hint } from "../shell/registry.ts";
import { Button, Primary, PrimaryScope } from "./button.tsx";
import { Field, Input } from "./field.tsx";

const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']";

/** Tab and ⇧Tab kept inside a box, from wherever focus is: true when it moved focus itself. */
export function trapTab(box: HTMLElement, back: boolean): boolean {
  const focusable = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return false;
  const active = document.activeElement;
  const to = !box.contains(active)
    ? back
      ? last
      : first
    : back && active === first
      ? last
      : !back && active === last
        ? first
        : null;
  to?.focus();
  return to !== null;
}

/**
 * A layer's keys, wherever focus is in the window (a click on its text leaves focus on the page): each of `keys` by
 * its chord, and Tab kept inside `box`.
 */
export function useModal(
  kind: "dialog" | "palette",
  box: RefObject<HTMLElement | null>,
  hints: Hint[],
  keys: Record<string, () => void>,
) {
  useLayer(kind, hints, (chord) => {
    const run = keys[chord];
    if (run) {
      run();
      return true;
    }
    if (box.current && (chord === "tab" || chord === "shift+tab")) return trapTab(box.current, chord === "shift+tab");
    return false;
  });
}

/**
 * One decision or one short form (components/dialog.md): Cancel then the action, ⌘↵ runs it, Esc cancels, Tab stays
 * inside. Its body is a form, so Enter in a one-line field runs it too. `danger` is a removal, confirmed in red.
 */
export function Dialog({
  title,
  children,
  action,
  danger = false,
  disabled = false,
  busy = false,
  wide = false,
  cancel = "Cancel",
  onAction,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  /** Names the consequence: "Retire the page", never "OK". */
  action: string;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** A form of a few fields: 560 instead of 440. */
  wide?: boolean;
  cancel?: string;
  onAction: (form: FormData) => void;
  onCancel: () => void;
}) {
  const heading = useId();
  const box = useRef<HTMLFormElement>(null);
  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (disabled || busy || !box.current) return;
    if (!box.current.reportValidity()) return;
    onAction(new FormData(box.current));
  };
  useModal(
    "dialog",
    box,
    [
      { keys: "mod+enter", says: action.toLowerCase() },
      { keys: "escape", says: cancel.toLowerCase() },
    ],
    { escape: onCancel, "mod+enter": () => submit() },
  );
  // Focus starts on the first field, or on Cancel in a removal; it goes back where it was after.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the dialog opens
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = danger
      ? box.current?.querySelector<HTMLElement>("input, [data-cancel]")
      : box.current?.querySelector<HTMLElement>("input, select, textarea, [data-action]");
    first?.focus();
    return () => previous?.focus();
  }, []);
  return createPortal(
    <div className="dialog-scrim">
      <PrimaryScope name={`The dialog "${title}"`}>
        <form
          ref={box}
          className={wide ? "dialog dialog-form" : "dialog"}
          role="dialog"
          aria-modal="true"
          aria-labelledby={heading}
          data-verb={action.toLowerCase()}
          noValidate
          onSubmit={submit}
        >
          <header className="dialog-header">
            <h2 className="dialog-title" id={heading}>
              {title}
            </h2>
          </header>
          {children && <div className="dialog-body">{children}</div>}
          <footer className="dialog-footer">
            <Button data-cancel onClick={onCancel}>
              {cancel}
            </Button>
            {danger ? (
              <Button type="submit" variant="danger" data-action disabled={disabled} busy={busy} keys="mod+enter">
                {action}
              </Button>
            ) : (
              <Primary type="submit" data-action disabled={disabled} busy={busy} keys="mod+enter">
                {action}
              </Primary>
            )}
          </footer>
        </form>
      </PrimaryScope>
    </div>,
    document.body,
  );
}

export interface Confirmation {
  title: string;
  /** What it means, in plain words: the reason to ask. */
  body: ReactNode;
  action: string;
  /** For what can't be undone: the thing's name, typed to confirm. */
  typed?: string;
  run: () => void;
}

/** Asks before a removal that can't be undone: `ask` opens the dialog, `dialog` is where it renders. */
export function useConfirm(): { ask: (confirmation: Confirmation) => void; dialog: ReactNode } {
  const [asking, setAsking] = useState<Confirmation | null>(null);
  const [typed, setTyped] = useState("");
  const dialog = asking && (
    <Dialog
      title={asking.title}
      action={asking.action}
      danger
      disabled={asking.typed !== undefined && typed !== asking.typed}
      onCancel={() => setAsking(null)}
      onAction={() => {
        setAsking(null);
        asking.run();
      }}
    >
      <p>{asking.body}</p>
      {asking.typed !== undefined && (
        <Field label={`Type “${asking.typed}” to confirm`}>
          <Input
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
          />
        </Field>
      )}
    </Dialog>
  );
  return {
    ask: (confirmation) => {
      setTyped("");
      setAsking(confirmation);
    },
    dialog,
  };
}

/** A danger button that asks first: a removal leads with its symbol, anything else ends with "…" (button.md). */
export function ConfirmButton({
  label,
  size = "md",
  disabled = false,
  ...confirmation
}: Confirmation & { label: string; size?: "sm" | "md"; disabled?: boolean }) {
  const { ask, dialog } = useConfirm();
  const removes = /^(remove|delete)\b/i.test(label);
  return (
    <>
      <Button
        variant="danger"
        size={size}
        icon={removes ? Trash2 : undefined}
        disabled={disabled}
        onClick={() => ask(confirmation)}
      >
        {removes ? label : `${label}…`}
      </Button>
      {dialog}
    </>
  );
}
