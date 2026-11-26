import type { Overview, Synced } from "@grenier/core/api";
import { ArrowLeft, ArrowRight, CircleHelp, Command as CommandIcon, FilePlus, Plus, RefreshCw } from "lucide-react";
import { type ComponentType, useCallback, useEffect, useMemo, useState } from "react";
import { ActivityProvider } from "./activity.tsx";
import { api, sendPageView } from "./api.ts";
import { since } from "./format.ts";
import { Banner } from "./shell/banner.tsx";
import { type Command, CommandProvider, useCommands } from "./shell/commands.tsx";
import { Palette } from "./shell/palette.tsx";
import { goLetters, PLACE_ICONS, PLACES, placeKeys } from "./shell/places.ts";
import { usePrefs } from "./shell/prefs.ts";
import { ItemTitleProvider, type RegionName } from "./shell/regions.tsx";
import { useRouter } from "./shell/router.ts";
import { Shortcuts } from "./shell/shortcuts.tsx";
import { Sidebar } from "./shell/sidebar.tsx";
import { StatusBar } from "./shell/status-bar.tsx";
import { TitleBar } from "./shell/title-bar.tsx";
import { LitPoint } from "./ui/brand.tsx";
import { mac } from "./ui/keys.ts";
import { useAction, useLoad } from "./ui/load.ts";
import { ToastProvider } from "./ui/toast.tsx";
import { TooltipLayer } from "./ui/tooltip.tsx";
import { SCREENS, type ViewName } from "./usage/screens.ts";
import { useUsage } from "./usage/use-usage.ts";
import { Cost } from "./views/Cost.tsx";
import { Instructions } from "./views/Instructions.tsx";
import { Knowledge } from "./views/Knowledge.tsx";
import { Mcp } from "./views/Mcp.tsx";
import { Routines } from "./views/Routines.tsx";
import { Settings } from "./views/Settings.tsx";
import { Skills } from "./views/Skills.tsx";
import { Team } from "./views/Team.tsx";

export interface ViewProps {
  /** What the route names in this place: a record, or `new` for the form that makes one. */
  item: string | undefined;
  /** Goes to a place, and to an item in it. */
  go: (place: ViewName, item?: string) => void;
  /** Tells the shell that something it shows (the records waiting to sync) may have changed. */
  changed: () => void;
  /** A member, not an admin: they read the team's pages, write in Me, and run what an admin shares. */
  member: boolean;
  /** The team this machine is in, null in none, undefined while the shell doesn't know yet. */
  team: Overview["team"] | undefined;
  /** In a team, and its admin: they add and change what the team shares. */
  admin: boolean;
  /** What the shell knows of this machine and its team, and why it doesn't when it failed; `changed` reloads it. */
  overview: { data: Overview | null; error: string | null };
}

export type { ViewName };

const VIEWS: Record<ViewName, ComponentType<ViewProps>> = {
  knowledge: Knowledge,
  cost: Cost,
  routines: Routines,
  skills: Skills,
  mcp: Mcp,
  instructions: Instructions,
  team: Team,
  settings: Settings,
};

const loadOverview = () => api<Overview>("/overview");

export function App() {
  return (
    <CommandProvider>
      <ActivityProvider>
        <ToastProvider>
          <Shell />
          <TooltipLayer />
        </ToastProvider>
      </ActivityProvider>
    </CommandProvider>
  );
}

const REGIONS: RegionName[] = ["sidebar", "list", "detail"];

/** Moves focus to the next region that is there (F6), or back (⇧F6): its selected row first, else its first control. */
function cycleRegions(by: 1 | -1) {
  const regions = REGIONS.map((name) => document.querySelector<HTMLElement>(`[data-region="${name}"]`)).filter(
    (region): region is HTMLElement => region !== null,
  );
  const at = regions.findIndex((region) => region.contains(document.activeElement));
  const next = regions[(at + by + regions.length) % regions.length];
  const inside = next?.querySelector<HTMLElement>(
    '[aria-current="page"], [role="tree"], [role="listbox"], button, a, input',
  );
  (inside ?? next)?.focus();
}

/** Focus starts in the list, or in the detail when there is none, never in the sidebar (app-shell.md#focus). */
function focusContent() {
  const list = document.querySelector<HTMLElement>(
    '[data-region="list"] [role="tree"], [data-region="list"] [role="listbox"]',
  );
  (list ?? document.querySelector<HTMLElement>('[data-region="detail"]'))?.focus({ preventScroll: true });
}

/** The laibe design system's app shell (patterns/app-shell.md): title bar, banner, sidebar, content, status bar. */
function Shell() {
  const router = useRouter();
  const { route, navigate, back, forward } = router;
  const overview = useLoad(loadOverview);
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [item, setItem] = useState<string | null>(null);
  usePrefs();
  const reloadOverview = overview.reload;
  const { run: runSync } = useAction(reloadOverview);
  const syncNow = useCallback(
    () =>
      void runSync(
        "sync",
        async () => {
          const done = await api<Synced>("/sync", { method: "POST" });
          return `Synced: sent ${done.pushed}, took ${done.pulled}`;
        },
        "Syncing",
      ),
    [runSync],
  );

  const go = useCallback(
    (place: ViewName, next?: string) => {
      navigate({ place, ...(next ? { item: next } : {}) });
      reloadOverview();
    },
    [navigate, reloadOverview],
  );

  const place = SCREENS[route.place].title;
  useEffect(() => {
    document.title = `${item ?? place} — Grenier`;
  }, [item, place]);

  const ready = overview.data !== null || overview.error !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each new place, once the shell is drawn
  useEffect(() => {
    if (ready) requestAnimationFrame(focusContent);
  }, [route.place, ready]);

  useUsage(SCREENS[route.place].url, sendPageView);

  const team = overview.data?.team ?? null;
  const commands = useMemo<Command[]>(() => {
    const names = [...PLACES, "settings" as const];
    const letters = goLetters(names);
    const places = names.flatMap((name): Command[] => {
      const letter = letters[name];
      const to = { label: SCREENS[name].title, icon: PLACE_ICONS[name], group: "Go to" as const, run: () => go(name) };
      return [
        { id: `go:${name}`, keys: placeKeys(name), ...to },
        ...(letter ? [{ id: `chord:${name}`, keys: `g ${letter}`, hidden: true, ...to }] : []),
      ];
    });
    return [
      ...places,
      {
        id: "palette",
        label: "Commands",
        icon: CommandIcon,
        keys: "mod+k",
        hidden: true,
        run: () => setPalette((open) => !open),
      },
      { id: "new-page", label: "New page", icon: FilePlus, run: () => go("knowledge", "new") },
      { id: "new-routine", label: "New routine", icon: Plus, run: () => go("routines", "new") },
      ...(team
        ? [
            {
              id: "sync",
              label: "Sync now",
              icon: RefreshCw,
              run: syncNow,
            },
          ]
        : []),
      { id: "back", label: "Back", icon: ArrowLeft, keys: "mod+[", run: back },
      { id: "forward", label: "Forward", icon: ArrowRight, keys: "mod+]", run: forward },
      { id: "region-next", label: "Next region", keys: "f6", run: () => cycleRegions(1) },
      { id: "region-back", label: "Previous region", keys: "shift+f6", run: () => cycleRegions(-1) },
      { id: "shortcuts", label: "Keyboard shortcuts", icon: CircleHelp, keys: "?", run: () => setShortcuts(true) },
    ];
  }, [go, back, forward, team, syncNow]);
  useCommands(commands, "shell");

  // The splash: the attic window on the dark, until the daemon first answers.
  if (!ready) {
    return (
      <div className="grid h-dvh place-items-center bg-void">
        <div className="grid justify-items-center gap-4">
          <span className="motion-safe:animate-pulse">
            <LitPoint size={64} />
          </span>
          <p className="font-mono text-xs text-muted">&gt; opening the store…</p>
        </div>
      </div>
    );
  }

  const View = VIEWS[route.place];

  return (
    <ItemTitleProvider value={setItem}>
      <div
        className="shell"
        style={
          {
            "--titlebar-height": mac ? "var(--layout-titlebar-mac)" : "var(--layout-titlebar)",
          } as React.CSSProperties
        }
      >
        <TitleBar
          place={place}
          item={item}
          canBack={router.canBack}
          canForward={router.canForward}
          onBack={back}
          onForward={forward}
          onCommands={() => setPalette(true)}
          store={{
            team: team
              ? {
                  host: new URL(team.url).host,
                  synced: team.lastSync ? `synced ${since(team.lastSync)}` : "not synced yet",
                }
              : null,
            sync: syncNow,
            openTeam: () => go("team"),
            create: () => go("team", "new"),
          }}
        />
        <Banner overview={overview.data} error={overview.error} retry={reloadOverview} toTeam={() => go("team")} />
        <Sidebar current={route.place} go={go} />
        <View
          key={route.place}
          item={route.item}
          go={go}
          changed={reloadOverview}
          member={overview.data?.role === "member"}
          team={overview.data ? team : undefined}
          admin={Boolean(team) && overview.data?.role !== "member"}
          overview={overview}
        />
        <StatusBar overview={overview.data} error={overview.error} go={go} retry={reloadOverview} />
        {palette && <Palette openPage={(id) => go("knowledge", id)} onClose={() => setPalette(false)} />}
        {shortcuts && <Shortcuts onClose={() => setShortcuts(false)} />}
      </div>
    </ItemTitleProvider>
  );
}
