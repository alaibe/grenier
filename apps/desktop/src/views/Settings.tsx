import { useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api, setUsageEnabled, usageEnabled } from "../api.ts";
import {
  Actions,
  Button,
  Card,
  Checkbox,
  Field,
  InlineForm,
  Input,
  Loading,
  Notice,
  Page,
  Part,
  Secret,
  useAction,
  useLoad,
} from "../ui.tsx";
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

const loadKeyState = () => api<{ unopened: number }>("/key");

/** The key that seals the Me folder: shown when asked, to put on this person's other machines. */
function PersonalKey() {
  const [key, setKey] = useState<string | null>(null);
  const state = useLoad(loadKeyState);
  const action = useAction(state.reload);
  const unopened = state.data?.unopened ?? 0;
  return (
    <Part
      title="Your personal key"
      intro="It seals your Me folder before it leaves this machine, and the team store never sees it. Use one key on all your machines: a machine with another key can't open your Me pages."
    >
      <Notice message={state.error ?? action.message} />
      {unopened > 0 && (
        <Notice
          message={{
            text: `${unopened === 1 ? "1 of your Me pages" : `${unopened} of your Me pages`} can't be opened here: another of your machines sealed ${unopened === 1 ? "it" : "them"} with its key. On that machine, open Settings and show its key, then use it here.`,
          }}
        />
      )}
      <Card className="grid gap-3">
        {key ? (
          <Secret value={key} copy="Copy key" />
        ) : (
          <Actions>
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
          </Actions>
        )}
        <InlineForm
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get("key") ?? "");
            void action.run("set", async () => {
              const saved = await api<{ unopened: number }>("/key", { method: "PUT", body: { key: value } });
              setKey(null);
              return {
                text:
                  saved.unopened > 0
                    ? "This machine uses that key now, but some Me pages still can't be opened: they were sealed with yet another key."
                    : "This machine uses that key now: your Me pages here are sealed with it, and those from your other machines open here.",
              };
            });
          }}
        >
          <Field className="flex-1">
            The key from your other machine. It replaces this machine's key: your Me pages here are sealed again with
            it, so a machine that still has the old key can't open them.
            <Input name="key" type="password" autoComplete="off" required />
          </Field>
          <Button type="submit" disabled={action.busy !== null}>
            Use it here
          </Button>
        </InlineForm>
      </Card>
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
        <Card>
          <Checkbox
            label="Share anonymous usage statistics"
            hint="Sends which screens you open, Grenier's version and your system to stats.laibe.cc, to count how Grenier is used. Nothing you write or read."
            checked={on}
            disabled={action.busy !== null}
            onChange={(event) => turn(event.currentTarget.checked)}
          />
        </Card>
      )}
    </Part>
  );
}
