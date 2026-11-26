import { ArrowLeft, ArrowRight, Command, LogIn, Plus, RefreshCw, Server, Users } from "lucide-react";
import { IconButton } from "../ui/button.tsx";
import { mac } from "../ui/keys.ts";
import { Menu } from "../ui/menu.tsx";

/** The team store this machine syncs with, or what to do without one. */
export interface StoreButton {
  /** Its address and when it last synced; null without a team. */
  team: { host: string; synced: string } | null;
  sync: () => void;
  openTeam: () => void;
  create: () => void;
}

/**
 * The top row (patterns/app-shell.md#title-bar): the window's mechanics and where you are, `Place / Item`, then the
 * team store and the palette as window buttons. The whole row drags the window.
 */
export function TitleBar({
  place,
  item,
  canBack,
  canForward,
  onBack,
  onForward,
  onCommands,
  store,
}: {
  place: string;
  item: string | null;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onCommands: () => void;
  store: StoreButton;
}) {
  return (
    <header
      data-tauri-drag-region
      className="titlebar-region flex items-center gap-1 border-b border-line bg-void pr-2 font-mono text-sm select-none"
      style={{ paddingLeft: mac ? "var(--layout-titlebar-mac-inset)" : "var(--space-2)" }}
    >
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
      <Menu
        icon={Server}
        label={
          store.team ? `Team store ${store.team.host}, ${store.team.synced}` : "No team store: join or create a team"
        }
        items={
          store.team
            ? [
                { label: "Sync now", icon: RefreshCw, run: store.sync },
                { label: "Open the team", icon: Users, run: store.openTeam },
              ]
            : [
                { label: "Join a team…", icon: LogIn, run: store.openTeam },
                { label: "Create a team…", icon: Plus, run: store.create },
              ]
        }
      />
      <IconButton label="Commands" keys="mod+k" icon={Command} size="sm" onClick={onCommands} />
    </header>
  );
}
