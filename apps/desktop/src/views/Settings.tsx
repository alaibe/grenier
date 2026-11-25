import type { KeyState, Overview, ShownKey } from "@grenier/core/api";
import { Eye } from "lucide-react";
import { useState } from "react";
import type { ViewProps } from "../App.tsx";
import { useSaved } from "../activity.tsx";
import { api, setUsageEnabled, usageEnabled } from "../api.ts";
import { type Theme, usePrefs } from "../shell/prefs.ts";
import { Detail } from "../shell/regions.tsx";
import { Button } from "../ui/button.tsx";
import { Toggle } from "../ui/choice.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Field, Input } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Notice, Problem } from "../ui/notice.tsx";
import { Page, Section, SectionRow } from "../ui/page.tsx";
import { Secret } from "../ui/secret.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { MachineSettings } from "./Machine.tsx";

const loadOverview = () => api<Overview>("/overview");

/** Everything set in one place (patterns/navigation.md): the app's look, this machine, the personal key. */
export function Settings(_: ViewProps) {
  return (
    <Detail title="Settings">
      <Page
        title="Settings"
        intro="How Grenier looks here, when this computer takes the team's routine runs, and your personal key."
      >
        <General />
        <MachineSettings />
        <PersonalKey />
      </Page>
    </Detail>
  );
}

const THEMES = [
  ["system", "System"],
  ["dark", "Dark"],
  ["light", "Light"],
] as const satisfies readonly (readonly [Theme, string])[];

function General() {
  const [prefs, setPrefs] = usePrefs();
  const saved = useSaved();
  const overview = useLoad(loadOverview);
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
        <span className="font-mono text-sm text-muted tabular-nums">{overview.data?.version ?? "…"}</span>
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
  return (
    <Section
      heading
      title="Your personal key"
      description="It seals your Me folder before it leaves this machine; the team store never sees it. Use one key on all your machines."
      actions={
        <>
          {!key && (
            <Button
              size="sm"
              icon={Eye}
              disabled={action.busy !== null}
              onClick={() =>
                void action.run("show", async () => {
                  setKey((await api<ShownKey>("/key", { method: "POST" })).key);
                  return undefined;
                })
              }
            >
              Show my key
            </Button>
          )}
          <Button size="sm" onClick={() => setUsing(true)}>
            Use another key…
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Problem error={state.error ?? action.problem} />
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
