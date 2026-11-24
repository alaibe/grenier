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
              await api("/key", { method: "PUT", body: { key: value } });
              return { text: "Saved: your Me pages from your other machines open here at the next sync." };
            });
          }}
        >
          <Field className="flex-1">
            The key from your other machine
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
