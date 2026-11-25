import { Undo2 } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type Command, useCommands } from "../shell/commands.tsx";
import { Button } from "./button.tsx";
import { Status } from "./tag.tsx";

export interface ToastInput {
  text: string;
  kind?: "ok" | "info";
  /** Puts back what the action did; the toast then offers Undo and ⌘Z. */
  undo?: () => void;
}

interface Shown extends ToastInput {
  id: number;
}

const SHOWN_MS = 4000;
const WITH_ACTION_MS = 8000;

const Toasts = createContext<(toast: ToastInput) => void>(() => {});

/** Brief feedback after an action worked (components/toast.md); a problem stays on the page instead. */
export const useToast = () => useContext(Toasts);

function Toast({ toast, dismiss }: { toast: Shown; dismiss: (id: number) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const close = useCallback(() => dismiss(toast.id), [dismiss, toast.id]);
  const start = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(close, toast.undo ? WITH_ACTION_MS : SHOWN_MS);
  }, [close, toast.undo]);
  useEffect(() => {
    start();
    return () => clearTimeout(timer.current);
  }, [start]);
  return (
    <div className="toast" role="status" onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={start}>
      <Status kind={toast.kind ?? "ok"} />
      <span className="toast-message">{toast.text}</span>
      {toast.undo && (
        <Button
          variant="ghost"
          size="sm"
          keys="mod+z"
          onClick={() => {
            toast.undo?.();
            close();
          }}
        >
          Undo
        </Button>
      )}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Shown[]>([]);
  const next = useRef(0);
  const push = useCallback((toast: ToastInput) => {
    next.current += 1;
    const id = next.current;
    setToasts((all) => [...all.slice(-2), { ...toast, id }]);
  }, []);
  const close = useCallback((id: number) => setToasts((all) => all.filter((toast) => toast.id !== id)), []);

  const newest = toasts.at(-1);
  const undoable = [...toasts].reverse().find((toast) => toast.undo);
  const commands = useMemo<Command[]>(
    () => [
      ...(newest
        ? [
            {
              id: "toast.dismiss",
              label: "Dismiss the message",
              keys: "escape",
              hidden: true,
              priority: 1,
              run: () => close(newest.id),
            },
          ]
        : []),
      ...(undoable
        ? [
            {
              id: "toast.undo",
              label: "Undo",
              icon: Undo2,
              keys: "mod+z",
              priority: 1,
              run: () => {
                undoable.undo?.();
                close(undoable.id);
              },
            },
          ]
        : []),
    ],
    [newest, undoable, close],
  );
  useCommands(commands);

  return (
    <Toasts value={push}>
      {children}
      <section className="toasts" aria-label="Notifications">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} dismiss={close} />
        ))}
      </section>
    </Toasts>
  );
}
