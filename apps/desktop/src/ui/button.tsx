import type { LucideIcon } from "lucide-react";
import { type ComponentProps, createContext, type ReactNode, useContext, useEffect, useRef } from "react";
import { Keys } from "./keycap.tsx";
import { type Shortcut, spoken } from "./keys.ts";

type Native = Omit<ComponentProps<"button">, "className" | "style" | "children">;

interface Common extends Native {
  size?: "sm" | "md" | "lg";
  /** Leading: a familiar symbol, or a button in a group that all have one (button.md#label-and-icon). */
  icon?: LucideIcon | undefined;
  /** Trailing: the button opens options or goes somewhere. */
  trailing?: LucideIcon | undefined;
  /** Its shortcut, drawn after the label. */
  keys?: Shortcut | undefined;
  /** Running: the label stays, a bar runs along the bottom, and it can't be pressed again. */
  busy?: boolean;
  children: ReactNode;
}

function inner(
  icon: LucideIcon | undefined,
  trailing: LucideIcon | undefined,
  keys: Shortcut | undefined,
  children: ReactNode,
) {
  const Lead = icon;
  const Trail = trailing;
  return (
    <>
      {Lead && <Lead className="icon" aria-hidden="true" />}
      {children}
      {Trail && <Trail className="icon" aria-hidden="true" />}
      {keys && <Keys shortcut={keys} />}
    </>
  );
}

const sizes = { sm: " btn-sm", md: "", lg: " btn-lg" };

/** Secondary unless asked: a ghost for toolbars and rows, danger for Delete, Revoke, Leave (components/button.md). */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  trailing,
  keys,
  busy = false,
  type = "button",
  onClick,
  children,
  ...props
}: Common & { variant?: "secondary" | "ghost" | "danger" }) {
  const look = variant === "ghost" ? " btn-ghost" : variant === "danger" ? " btn-danger" : "";
  return (
    <button
      type={type}
      className={`btn${look}${sizes[size]}`}
      aria-busy={busy || undefined}
      onClick={busy ? undefined : onClick}
      {...props}
    >
      {inner(icon, trailing, keys, children)}
    </button>
  );
}

/** A square ghost button for a rule-2 symbol, named by its tooltip, which also gives its shortcut. */
export function IconButton({
  label,
  icon: Glyph,
  keys,
  size = "md",
  ...props
}: Omit<Native, "aria-label" | "title"> & {
  label: string;
  icon: LucideIcon;
  keys?: Shortcut | undefined;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-icon${sizes[size]}`}
      aria-label={label}
      title={label}
      data-keys={keys}
      aria-keyshortcuts={keys ? spoken(keys) : undefined}
      {...props}
    >
      <Glyph className="icon" aria-hidden="true" />
    </button>
  );
}

const Scope = createContext<{ name: string; count: { current: number } } | null>(null);

/** Where one primary button may show: a screen, or a dialog over it. */
export function PrimaryScope({ name, children }: { name: string; children: ReactNode }) {
  const count = useRef(0);
  return <Scope value={{ name, count }}>{children}</Scope>;
}

/** The one action a screen or a dialog is for: neon, chamfered. A second one in the same scope is a bug. */
export function Primary({
  size = "md",
  icon,
  trailing,
  keys,
  busy = false,
  type = "button",
  onClick,
  children,
  ...props
}: Common) {
  const scope = useContext(Scope);
  useEffect(() => {
    if (!scope) return;
    scope.count.current += 1;
    if (scope.count.current > 1) console.error(`${scope.name} shows ${scope.count.current} primary buttons: keep one.`);
    return () => {
      scope.count.current -= 1;
    };
  }, [scope]);
  return (
    <button
      type={type}
      className={`btn btn-primary${sizes[size]}`}
      aria-busy={busy || undefined}
      onClick={busy ? undefined : onClick}
      {...props}
    >
      {inner(icon, trailing, keys, children)}
    </button>
  );
}
