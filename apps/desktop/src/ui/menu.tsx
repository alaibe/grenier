import { Ellipsis, type LucideIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./button.tsx";
import { Keys } from "./keycap.tsx";
import type { Shortcut } from "./keys.ts";

export interface MenuItem {
  label: string;
  icon: LucideIcon;
  keys?: Shortcut;
  /** A removal: last, after a separator, in danger. */
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** A row's full set of actions behind its ⋯ button (components/menu.md): ↑↓ move, Enter runs, Esc closes. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const button = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const ordered = [...items.filter((item) => !item.danger), ...items.filter((item) => item.danger)];

  useEffect(() => {
    if (!at) return;
    menu.current?.focus();
    const away = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setAt(null);
    };
    document.addEventListener("pointerdown", away);
    window.addEventListener("resize", () => setAt(null), { once: true });
    return () => document.removeEventListener("pointerdown", away);
  }, [at]);

  const close = () => {
    setAt(null);
    button.current?.querySelector("button")?.focus();
  };
  const run = (item: MenuItem | undefined) => {
    if (!item || item.disabled) return;
    close();
    item.run();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = (by: number) => setHighlighted((index) => (index + by + ordered.length) % ordered.length);
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Enter" || event.key === " ") run(ordered[highlighted]);
    else if (event.key === "Escape" || event.key === "ArrowLeft" || event.key === "Tab") close();
    else if (event.key.length === 1) {
      const letter = event.key.toLowerCase();
      const next = ordered.findIndex(
        (item, index) => index > highlighted && item.label.toLowerCase().startsWith(letter),
      );
      const first = ordered.findIndex((item) => item.label.toLowerCase().startsWith(letter));
      if (next >= 0 || first >= 0) setHighlighted(next >= 0 ? next : first);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      <span ref={button} className="inline-flex">
        <IconButton
          label={label}
          icon={Ellipsis}
          size="sm"
          aria-haspopup="menu"
          aria-expanded={at !== null}
          aria-controls={at ? id : undefined}
          onClick={(event) => {
            if (at) return setAt(null);
            const box = event.currentTarget.getBoundingClientRect();
            setHighlighted(0);
            setAt({ top: box.bottom + 4, right: window.innerWidth - box.right });
          }}
        />
      </span>
      {at &&
        createPortal(
          <div
            ref={menu}
            id={id}
            className="menu"
            role="menu"
            aria-label={label}
            tabIndex={-1}
            style={{ position: "fixed", top: at.top, right: at.right, zIndex: "var(--layer-popover)" }}
            onKeyDown={keyDown}
          >
            {ordered.map((item, index) => (
              <div key={item.label}>
                {item.danger && !ordered[index - 1]?.danger && index > 0 && <hr className="menu-separator border-0" />}
                <div
                  className={item.danger ? "menu-item menu-item-danger" : "menu-item"}
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={item.disabled || undefined}
                  data-highlighted={index === highlighted || undefined}
                  onPointerMove={() => setHighlighted(index)}
                  onClick={() => run(item)}
                  onKeyDown={() => {}}
                >
                  <item.icon className="icon" aria-hidden="true" />
                  {item.label}
                  {item.keys && <Keys shortcut={item.keys} />}
                </div>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
