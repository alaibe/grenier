import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/button.tsx";
import { useModal } from "../ui/dialog.tsx";
import { Keys } from "../ui/keycap.tsx";
import { spoken } from "../ui/keys.ts";
import { type Command, useRegistryState } from "./commands.tsx";

/**
 * What `?` opens: every shortcut of the current view, then its actions that have none, which the palette runs, from
 * the same registry the keys run (patterns/keyboard.md).
 */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  const { registry } = useRegistryState();
  const close = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useModal("dialog", box, [{ keys: "escape", says: "close" }], { escape: onClose, "?": onClose });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => previous?.focus();
  }, []);
  const keyed = registry.commands.filter((command) => command.keys);
  const groups: [string, Command[]][] = [
    ["Go to", keyed.filter((command) => command.group === "Go to")],
    ["Actions", keyed.filter((command) => command.group !== "Go to")],
    [`In the palette, ${spoken("mod+k")}`, registry.commands.filter((command) => !command.keys && !command.hidden)],
  ];
  return createPortal(
    <div className="dialog-scrim">
      <div ref={box} className="dialog dialog-form" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <header className="dialog-header">
          <h2 className="dialog-title" id="shortcuts-title">
            Keyboard shortcuts
          </h2>
        </header>
        <div className="dialog-body max-h-[60vh] overflow-y-auto">
          {groups.map(
            ([name, commands]) =>
              commands.length > 0 && (
                <section key={name}>
                  <h3 className="label mb-1">{name}</h3>
                  <table className="table">
                    <tbody>
                      {commands.map((command) => (
                        <tr key={command.id}>
                          <td className="text-fg">{command.label}</td>
                          <td className="num">{command.keys && <Keys shortcut={command.keys} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ),
          )}
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
