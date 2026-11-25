import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/button.tsx";
import { Keys } from "../ui/keycap.tsx";
import { type Command, useLayer, useRegistryState } from "./commands.tsx";

/** What `?` opens: every shortcut of the current view, from the same registry the keys run (patterns/keyboard.md). */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  const { registry } = useRegistryState();
  const close = useRef<HTMLButtonElement>(null);
  useLayer("dialog", [{ keys: "escape", says: "close" }]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => previous?.focus();
  }, []);
  const keyed = registry.commands.filter((command): command is Command & { keys: string } => Boolean(command.keys));
  const groups: [string, Command[]][] = [
    ["Go to", keyed.filter((command) => command.group === "Go to")],
    ["Actions", keyed.filter((command) => command.group !== "Go to")],
  ];
  return createPortal(
    <div className="dialog-scrim">
      <div
        className="dialog dialog-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onKeyDown={(event) => {
          if (event.key !== "Escape" && event.key !== "?") return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <header className="dialog-header">
          <h2 className="dialog-title" id="shortcuts-title">
            Keyboard shortcuts
          </h2>
        </header>
        <div className="dialog-body max-h-[60vh] overflow-y-auto">
          {groups.map(([name, commands]) => (
            <section key={name}>
              <h3 className="label mb-1">{name}</h3>
              <table className="table">
                <tbody>
                  {commands.map((command) => (
                    <tr key={command.id}>
                      <td className="text-fg">{command.label}</td>
                      <td className="num">
                        <Keys shortcut={command.keys ?? ""} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <footer className="dialog-footer">
          <Button ref={close} onClick={onClose} keys="escape">
            Close
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
