import { ArrowLeft, ArrowRight, Command, PanelLeft } from "lucide-react";
import { IconButton } from "../ui/button.tsx";
import { mac } from "../ui/keys.ts";

/**
 * The top row (patterns/app-shell.md#title-bar): the window's mechanics and where you are, `Place / Item`, and the
 * palette as the one window button. The whole row drags the window.
 */
export function TitleBar({
  place,
  item,
  collapsed,
  canBack,
  canForward,
  onToggleSidebar,
  onBack,
  onForward,
  onCommands,
}: {
  place: string;
  item: string | null;
  collapsed: boolean;
  canBack: boolean;
  canForward: boolean;
  onToggleSidebar: () => void;
  onBack: () => void;
  onForward: () => void;
  onCommands: () => void;
}) {
  return (
    <header
      data-tauri-drag-region
      className="titlebar-region flex items-center gap-1 border-b border-line bg-void pr-2 font-mono text-sm select-none"
      style={{ paddingLeft: mac ? "var(--layout-titlebar-mac-inset)" : "var(--space-2)" }}
    >
      {collapsed && (
        <IconButton label="Show the sidebar" keys="mod+\" icon={PanelLeft} size="sm" onClick={onToggleSidebar} />
      )}
      <IconButton label="Back" keys="mod+[" icon={ArrowLeft} size="sm" disabled={!canBack} onClick={onBack} />
      <IconButton label="Forward" keys="mod+]" icon={ArrowRight} size="sm" disabled={!canForward} onClick={onForward} />
      <p data-tauri-drag-region className="ml-2 min-w-0 flex-1 truncate">
        <span className={item ? "text-muted" : "text-fg"}>{place}</span>
        {item && (
          <>
            <span className="text-muted"> / </span>
            <span className="text-fg">{item}</span>
          </>
        )}
      </p>
      <IconButton label="Commands" keys="mod+k" icon={Command} size="sm" onClick={onCommands} />
    </header>
  );
}
