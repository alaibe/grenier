import { ArrowLeft, ArrowRight, type LucideIcon, PanelLeft, Search } from "lucide-react";
import { Kbd } from "../ui.tsx";

/** True on macOS, where the window's buttons sit in the title bar (titleBarStyle "Overlay" in tauri.conf.json). */
export const mac = navigator.userAgent.includes("Mac");

/** The top row: the window's mechanics and where you are, nothing else. The whole row drags the window. */
export function TitleBar({
  place,
  collapsed,
  canBack,
  canForward,
  onToggleSidebar,
  onMove,
  onCommands,
}: {
  place: string;
  collapsed: boolean;
  canBack: boolean;
  canForward: boolean;
  onToggleSidebar: () => void;
  onMove: (by: number) => void;
  onCommands: () => void;
}) {
  return (
    <header
      data-tauri-drag-region
      className="z-(--layer-bars) flex items-center gap-1 border-b border-line bg-void pr-2 font-mono text-sm select-none"
      style={{ paddingLeft: mac ? 76 : 8 }}
    >
      {collapsed && <IconButton label="Show the sidebar" keys="⌘\" icon={PanelLeft} onClick={onToggleSidebar} />}
      <IconButton label="Back" keys="⌘[" icon={ArrowLeft} disabled={!canBack} onClick={() => onMove(-1)} />
      <IconButton label="Forward" keys="⌘]" icon={ArrowRight} disabled={!canForward} onClick={() => onMove(1)} />
      <p data-tauri-drag-region className="ml-2 min-w-0 flex-1 truncate text-fg">
        {place}
      </p>
      <button
        type="button"
        onClick={onCommands}
        className="flex h-6 cursor-pointer items-center gap-2 rounded-md border border-line bg-bg px-2 text-xs text-muted hover:border-line-strong hover:text-fg"
      >
        <Search size={13} aria-hidden="true" />
        Commands
        <Kbd>⌘K</Kbd>
      </button>
    </header>
  );
}

/** A square ghost button for the title bar and toolbars: an icon, with its name and shortcut as the tooltip. */
export function IconButton({
  label,
  keys,
  icon: Icon,
  disabled = false,
  onClick,
}: {
  label: string;
  keys?: string;
  icon: LucideIcon;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={keys ? `${label}  ${keys}` : label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 cursor-pointer place-items-center rounded-md text-muted enabled:hover:bg-hover enabled:hover:text-fg disabled:cursor-default disabled:opacity-40"
    >
      <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
