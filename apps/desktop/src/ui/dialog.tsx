import { Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLayer } from "../shell/commands.tsx";
import { Button, Primary, PrimaryScope } from "./button.tsx";
import { Field, Input } from "./field.tsx";

const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']";

/**
 * One decision or one short form (components/dialog.md): Cancel then the action, ⌘↵ runs it, Esc cancels, Tab stays
 * inside. Its body is a form, so Enter in a one-line field runs it too. `danger` is a removal, confirmed in red.
 */
export function Dialog({
  title,
  label,
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
  /** Above the title, in the label role: DELETE ACCOUNT. */
  label?: string;
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
  useLayer("dialog", [
    { keys: "mod+enter", says: action.toLowerCase() },
    { keys: "escape", says: cancel.toLowerCase() },
  ]);
  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (disabled || busy || !box.current) return;
    if (!box.current.reportValidity()) return;
    onAction(new FormData(box.current));
  };
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
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            } else if (event.key === "Tab" && box.current) {
              const focusable = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
              const first = focusable[0];
              const last = focusable.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <header className="dialog-header">
            {label && <span className="label">{label}</span>}
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
