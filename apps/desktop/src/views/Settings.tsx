import { useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api, setUsageEnabled, usageEnabled } from "../api.ts";
import { Button, Field, Input, Loading, Notice, Page, Part, useAction, useLoad } from "../ui.tsx";
import { Machine } from "./Machine.tsx";

export function Settings(props: ViewProps) {
  return (
    <Page
      title="Settings"
      intro="This computer: when it takes the team's routine runs, your personal key, and usage statistics."
    >
      <Machine {...props} />
      <PersonalKey />
      <UsageStatistics />
    </Page>
  );
}

/** The key that seals the Me folder: shown when asked, to put on this person's other machines. */
function PersonalKey() {
  const [key, setKey] = useState<string | null>(null);
  const action = useAction(() => {});
  return (
    <Part
      title="Your personal key"
      intro="It seals your Me folder before it leaves this machine. Put the same key on your other machines so your Me pages open there too. The team store never sees it."
    >
      <Notice message={action.message} />
      <div className="grid gap-3 rounded-xl border border-line bg-panel px-5 py-4">
        {key ? (
          <code className="block break-all whitespace-normal select-all">{key}</code>
        ) : (
          <div>
            <Button
              quiet
              disabled={action.busy !== null}
              onClick={() =>
                void action.run("show", async () => {
                  setKey((await api<{ key: string }>("/key", { method: "POST" })).key);
                  return undefined;
                })
              }
            >
              Show my key
            </Button>
          </div>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get("key") ?? "");
            void action.run("set", async () => {
              await api("/key", { method: "PUT", body: { key: value } });
              return { text: "Saved: your Me pages from your other machines open here at the next sync." };
            });
          }}
        >
          <div className="flex-1">
            <Field>
              The key from your other machine
              <Input name="key" type="password" autoComplete="off" required />
            </Field>
          </div>
          <Button type="submit" disabled={action.busy !== null}>
            Use it here
          </Button>
        </form>
      </div>
    </Part>
  );
}

function UsageStatistics() {
  const { data: on, error, reload } = useLoad(usageEnabled);
  const action = useAction(reload);

  const turn = (enabled: boolean) =>
    void action.run("usage", async () => {
      await setUsageEnabled(enabled);
      return {
        text: enabled
          ? "Usage statistics are on."
          : "Usage statistics are off, and the random id they were counted by is deleted.",
      };
    });

  return (
    <Part title="Usage statistics">
      <Notice message={error ?? action.message} />
      {on === null && !error && <Loading what="settings" />}
      {on !== null && (
        <section className="rounded-xl border border-line bg-panel px-5 py-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 accent-accent"
              checked={on}
              disabled={action.busy !== null}
              onChange={(event) => turn(event.currentTarget.checked)}
            />
            <span>
              <span className="font-medium">Share anonymous usage statistics</span>
              <span className="mt-0.5 block text-md text-muted">
                Sends which screens you open, Grenier's version and your system to stats.laibe.cc, to count how Grenier
                is used. Nothing you write or read.
              </span>
            </span>
          </label>
        </section>
      )}
    </Part>
  );
}
