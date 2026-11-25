import type { AppView, ClientMade, Clients } from "@grenier/core/api";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "../api.ts";
import { exact } from "../format.ts";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/choice.tsx";
import { ConfirmButton, Dialog } from "../ui/dialog.tsx";
import { Skeleton } from "../ui/empty.tsx";
import { Field, Input } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Notice, Problem } from "../ui/notice.tsx";
import { Section, SectionRow } from "../ui/page.tsx";
import { Secret } from "../ui/secret.tsx";
import { RowActions, Table } from "../ui/table.tsx";
import { Status, Tag } from "../ui/tag.tsx";

const load = () => api<Clients>("/clients");
const loadApps = () => api<{ apps: AppView[] }>("/apps").then((answer) => answer.apps);

/** For the MCP screen: the apps on this computer that read Grenier, each with its own key. */
export function Apps() {
  const clients = useLoad(load);
  const apps = useLoad(loadApps);
  const action = useAction(() => {
    clients.reload();
    apps.reload();
  });
  const [making, setMaking] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);

  return (
    <Section
      heading
      title="Apps on this computer"
      description="Claude Code, Cursor and other apps here read Grenier over MCP, each with its own key. Each reads its repository's folder, plus the top folders it is given. Only you see this list."
      actions={
        <Button size="sm" onClick={() => setMaking(true)}>
          Another app…
        </Button>
      }
    >
      <div className="grid gap-4">
        <Problem error={apps.error ?? clients.error ?? action.problem} />
        {created && (
          <Notice
            kind="accent"
            tag="ONCE"
            onDismiss={() => setCreated(null)}
            more="Copy it now: it is shown only once."
          >
            The key for {created.name}: give it to the app as <code>GRENIER_CLIENT_TOKEN</code> (stdio) or as{" "}
            <code>Authorization: Bearer</code> (HTTP).
          </Notice>
        )}
        {created && <Secret label={`Key for ${created.name}`} value={created.token} />}
        {!apps.data && !apps.error && <Skeleton rows={2} />}
        {apps.data?.map((entry) => (
          <SectionRow
            key={entry.app}
            label={entry.label}
            description={entry.connected ? "Reads Grenier, every folder." : "Doesn't read Grenier yet."}
          >
            <div className="flex items-center gap-3">
              {entry.connected && <Status kind="ok" word="added" />}
              <Button
                size="sm"
                icon={entry.connected ? RefreshCw : Plus}
                disabled={action.busy !== null}
                busy={action.busy === `app:${entry.app}`}
                title={entry.connected ? "Adding it again gives it a new key" : undefined}
                onClick={() =>
                  void action.run(`app:${entry.app}`, async () => {
                    await api(`/apps/${entry.app}`, { body: { scopes: ["*"] } });
                    return `Added Grenier to ${entry.label}: restart it to load Grenier`;
                  })
                }
              >
                {entry.connected ? "Add again" : "Add Grenier"}
              </Button>
            </div>
          </SectionRow>
        ))}
        {clients.data && clients.data.clients.length > 0 && (
          <Section title="Keys">
            <Table
              label="Apps' keys"
              head={
                <>
                  <th>App</th>
                  <th>May read</th>
                  <th>Created</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </>
              }
            >
              {clients.data.clients.map((client) => (
                <tr key={client.name}>
                  <td className="mono">{client.name}</td>
                  <td className="whitespace-normal">
                    {client.scopes.length > 0 ? (
                      <span className="inline-flex flex-wrap gap-1">
                        {client.scopes.map((scope) => (
                          <Tag key={scope}>{scope}</Tag>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted">repositories only</span>
                    )}
                  </td>
                  <td className="mono">{exact(client.createdAt)}</td>
                  <RowActions>
                    <ConfirmButton
                      label="Revoke"
                      size="sm"
                      disabled={action.busy !== null}
                      title={`Revoke ${client.name}?`}
                      body="Its next call to Grenier fails. Adding it again gives it a new key."
                      action="Revoke the key"
                      run={() =>
                        void action.run(`revoke:${client.name}`, async () => {
                          await api(`/clients/${encodeURIComponent(client.name)}/revoke`, { method: "POST" });
                          return `Revoked ${client.name}`;
                        })
                      }
                    />
                  </RowActions>
                </tr>
              ))}
            </Table>
            <p className="mt-2 text-sm text-muted">
              An app added with its button reads every folder. To give it fewer, revoke it and make it a key with only
              the folders it may read.
            </p>
          </Section>
        )}
      </div>
      {making && (
        <Dialog
          title="Another app"
          action="Make its key"
          busy={action.busy !== null}
          onCancel={() => setMaking(false)}
          onAction={(form) => {
            const name = String(form.get("name") ?? "").trim();
            void action.run("create", async () => {
              const result = await api<ClientMade>("/clients", {
                body: { name, scopes: form.getAll("scope").map(String) },
              });
              setCreated({ name, token: result.token });
              setMaking(false);
              return `Made a key for ${name}`;
            });
          }}
        >
          <p>You get a key to give the app yourself. Nothing is installed.</p>
          <Problem error={action.problem} />
          <Field label="Name">
            <Input name="name" mono required pattern="[\w.@\-]+" placeholder="claude-desktop" autoComplete="off" />
          </Field>
          <fieldset className="choice-group">
            <legend className="label">May read</legend>
            {(clients.data?.scopes ?? []).map((scope) => (
              <Checkbox key={scope} name="scope" value={scope} label={scope} />
            ))}
            <p className="field-help">
              With nothing ticked, it reads only the repositories' folders. * is every top folder.
            </p>
          </fieldset>
        </Dialog>
      )}
    </Section>
  );
}
