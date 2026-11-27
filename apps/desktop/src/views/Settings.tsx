import type { KeyState, ShownKey } from "@grenier/core/api";
import { AppWindow, Cpu, Eye, Flag, KeyRound, Lightbulb, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import type { ViewProps } from "../App.tsx";
import { useSaved } from "../activity.tsx";
import { api, openFeedback, setUsageEnabled, usageEnabled } from "../api.ts";
import { PageCommands } from "../shell/commands.tsx";
import { type Theme, usePrefs } from "../shell/prefs.ts";
import { ListDetail } from "../shell/regions.tsx";
import { Button } from "../ui/button.tsx";
import { Toggle } from "../ui/choice.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Field, Input } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Notice, Problem } from "../ui/notice.tsx";
import { Section, SectionRow } from "../ui/page.tsx";
import { Secret } from "../ui/secret.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { Tree } from "../ui/tree.tsx";
import { Apps } from "./Apps.tsx";
import { MachineSettings } from "./Machine.tsx";

/** Settings' areas, in the list beside the one that is open: `#settings/<area>`. */
const AREAS = [
  { id: "general", name: "General", icon: SlidersHorizontal, View: General },
  { id: "machine", name: "This machine", icon: Cpu, View: MachineSettings },
  { id: "key", name: "Your personal key", icon: KeyRound, View: PersonalKey },
  { id: "apps", name: "Apps", icon: AppWindow, View: Apps },
] as const;

/** Every setting in one place (patterns/navigation.md), an area at a time: its list beside the area that is open. */
export function Settings({ item, go, overview }: ViewProps) {
  const area = AREAS.find((entry) => entry.id === item) ?? AREAS[0];
  return (
    <ListDetail
      title="Settings"
      list={
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Tree
            label="Settings"
            nodes={AREAS.map(({ id, name, icon }) => ({ id, name, icon }))}
            selected={area.id}
            onSelect={(node) => go("settings", node.id)}
            onOpen={(node) => go("settings", node.id)}
          />
        </div>
      }
    >
      <div className="px-6 pt-6 pb-12">
        <area.View version={overview.data?.version ?? null} />
      </div>
    </ListDetail>
  );
}

const THEMES = [
  ["system", "System"],
  ["dark", "Dark"],
  ["light", "Light"],
] as const satisfies readonly (readonly [Theme, string])[];

function General({ version }: { version: string | null }) {
  const [prefs, setPrefs] = usePrefs();
  const saved = useSaved();
  const usage = useLoad(usageEnabled);
  const action = useAction(usage.reload);
  const set = (change: Parameters<typeof setPrefs>[0]) => {
    setPrefs(change);
    saved();
  };
  return (
    <Section heading title="General">
      <SectionRow label="Theme" description="System follows your computer's light or dark mode.">
        <Segmented label="Theme" options={THEMES} value={prefs.theme} onChange={(theme) => set({ theme })} />
      </SectionRow>
      <div className="section-row">
        <div className="flex-1">
          <Toggle
            label="Quick tips"
            description="The keys that matter right now, at the right of the status bar."
            checked={prefs.tips}
            onChange={(event) => set({ tips: event.currentTarget.checked })}
          />
        </div>
      </div>
      <div className="section-row">
        <div className="flex-1">
          <Toggle
            label="Usage statistics"
            description="Sends the name and address of each screen you open, your display's size, Grenier's version, your system's name and a random id to stats.laibe.cc. Nothing you write or read."
            checked={usage.data ?? false}
            disabled={usage.data === null || action.busy !== null}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void action.run("usage", async () => {
                await setUsageEnabled(enabled);
                saved();
                return enabled ? undefined : "Turned usage statistics off, and deleted the random id they counted by";
              });
            }}
          />
        </div>
      </div>
      {usage.error && <Notice kind="info">{usage.error}</Notice>}
      <Problem error={action.problem} />
      <SectionRow label="Version">
        <span className="font-mono text-sm text-muted tabular-nums">{version ?? "…"}</span>
      </SectionRow>
      <SectionRow
        label="Report a problem"
        description="Opens a public issue form on GitHub, with Grenier's version and your system's name."
      >
        <Button
          size="sm"
          icon={Flag}
          onClick={() => void action.run("problem", () => openFeedback("problem").then(() => undefined))}
        >
          Report a problem
        </Button>
      </SectionRow>
      <SectionRow label="Suggest a feature" description="Opens a public issue form on GitHub.">
        <Button
          size="sm"
          icon={Lightbulb}
          onClick={() => void action.run("feature", () => openFeedback("feature").then(() => undefined))}
        >
          Suggest a feature
        </Button>
      </SectionRow>
    </Section>
  );
}

const loadKeyState = () => api<KeyState>("/key");

/** The key that seals the Me folder: shown when asked, to put on this person's other machines. */
function PersonalKey() {
  const [key, setKey] = useState<string | null>(null);
  const [using, setUsing] = useState(false);
  const state = useLoad(loadKeyState);
  const action = useAction(state.reload);
  const unopened = state.data?.unopened ?? 0;
  const show = () =>
    void action.run("show", async () => {
      setKey((await api<ShownKey>("/key", { method: "POST" })).key);
      return undefined;
    });
  return (
    <Section
      heading
      title="Your personal key"
      description="It seals your Me folder before it leaves this machine; the team store never sees it. Use one key on all your machines."
      actions={
        <>
          {!key && (
            <Button size="sm" icon={Eye} disabled={action.busy !== null} onClick={show}>
              Show my key
            </Button>
          )}
          <Button size="sm" onClick={() => setUsing(true)}>
            Use another key…
          </Button>
        </>
      }
    >
      <PageCommands
        commands={[
          ...(key ? [] : [{ id: "key.show", label: "Show my key", icon: Eye, run: show }]),
          { id: "key.use", label: "Use another key…", icon: KeyRound, run: () => setUsing(true) },
        ]}
      />
      <div className="grid gap-3">
        <Problem error={state.error ?? action.problem} retry={state.error ? state.reload : undefined} />
        {unopened > 0 && (
          <Notice
            kind="warn"
            more="On that machine, open Settings and show its key, then use it here."
            action={
              <Button size="sm" onClick={() => setUsing(true)}>
                Use another key…
              </Button>
            }
          >
            {unopened === 1 ? "1 of your Me pages" : `${unopened} of your Me pages`} can't be opened here: another of
            your machines sealed {unopened === 1 ? "it" : "them"} with its key.
          </Notice>
        )}
        {key && <Secret label="Your key" value={key} help="Put it on your other machines, under Use another key." />}
      </div>
      {using && (
        <Dialog
          title="Use another key"
          action="Use it here"
          busy={action.busy !== null}
          onCancel={() => setUsing(false)}
          onAction={(form) =>
            void action.run("set", async () => {
              const saved = await api<KeyState>("/key", {
                method: "PUT",
                body: { key: String(form.get("key") ?? "") },
              });
              setKey(null);
              setUsing(false);
              return saved.unopened > 0
                ? "This machine uses that key now; some Me pages were sealed with yet another one"
                : "This machine uses that key now";
            })
          }
        >
          <p>
            It replaces <strong>this machine's key</strong>: your Me pages here are sealed again with it, so a machine
            that still has the old key can't open them.
          </p>
          <Problem error={action.problem} />
          <Field label="Key" help="From Show my key, on your other machine.">
            <Input name="key" type="password" mono autoComplete="off" required />
          </Field>
        </Dialog>
      )}
    </Section>
  );
}
