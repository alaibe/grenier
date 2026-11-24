import type { AppView, ClientMade, Clients } from "@grenier/core/api";
import { type FormEvent, useState } from "react";
import { api } from "../api.ts";
import {
  Actions,
  Button,
  Card,
  ConfirmButton,
  Empty,
  Field,
  FormCard,
  Input,
  Loading,
  Notice,
  Part,
  Secret,
  Table,
  Tag,
  useAction,
  useAdding,
  useLoad,
} from "../ui.tsx";

const load = () => api<Clients>("/clients");
const loadApps = () => api<{ apps: AppView[] }>("/apps").then((answer) => answer.apps);

/** One click adds Grenier's MCP server to an app here, able to read every folder; narrow it in the list below. */
function Connect({ added }: { added: () => void }) {
  const apps = useLoad(loadApps);
  const action = useAction(() => {
    apps.reload();
    added();
  });
  return (
    <div className="mb-5">
      <Notice message={apps.error ?? action.message} />
      <div className="flex flex-wrap gap-2">
        {(apps.data ?? []).map((entry) => (
          <Button
            key={entry.app}
            quiet={entry.connected}
            disabled={action.busy !== null}
            title={entry.connected ? "Added already: adding it again gives it a new key" : undefined}
            onClick={() =>
              void action.run(`app:${entry.app}`, async () => {
                await api(`/apps/${entry.app}`, { body: { scopes: ["*"] } });
                return { text: `Added to ${entry.label}: restart it to load Grenier.` };
              })
            }
          >
            {entry.connected ? `${entry.label} ✓` : `Add to ${entry.label}`}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** For the MCP screen: the apps on this computer that read Grenier, each with its own key. */
export function Apps() {
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);
  const adding = useAdding("Another app");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const scopes = form.getAll("scope").map(String);
    void action
      .run("create", async () => {
        const result = await api<ClientMade>("/clients", { body: { name, scopes } });
        setCreated({ name, token: result.token });
        return undefined;
      })
      .then((done) => {
        if (done) adding.done();
      });
  };

  return (
    <Part
      title="Apps on this computer"
      intro={
        <>
          Claude Code, Cursor and other apps here read Grenier over MCP, each with its own key. Add Grenier to one with
          its button. Each reads its repository's folder, plus the top folders it is given: Me, Team, or one for some
          members. Only you see this list.
        </>
      }
      action={!adding.open && adding.button}
    >
      <Connect added={reload} />
      <Notice message={error ?? action.message} />

      {created && (
        <Card tone="accent" role="status">
          <h3 className="font-semibold">Token for {created.name}</h3>
          <Secret
            className="mt-1.5"
            value={created.token}
            copy="Copy token"
            note={
              <>
                Copy it now: it is shown only once. Give it to the app as <code>GRENIER_CLIENT_TOKEN</code> (stdio) or
                as <code>Authorization: Bearer</code> (HTTP).
              </>
            }
          >
            <Button quiet onClick={() => setCreated(null)}>
              Done
            </Button>
          </Secret>
        </Card>
      )}

      {adding.open && (
        <FormCard className="max-w-150" onSubmit={add}>
          <h3 className="font-semibold">Another app</h3>
          <p className="text-sm text-muted">You get a token to give the app yourself. It is not installed anywhere.</p>
          <Field>
            Name
            <Input name="name" required pattern="[\w.@\-]+" placeholder="claude-desktop" autoComplete="off" />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">May read</legend>
            <div className="flex flex-wrap gap-1.5">
              {(data?.scopes ?? []).map((scope) => (
                <label
                  key={scope}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1"
                >
                  <input type="checkbox" className="accent-accent" name="scope" value={scope} />
                  {scope}
                </label>
              ))}
            </div>
            <span className="text-sm text-muted">
              With nothing ticked, it reads only the repositories' folders. * is every top folder.
            </span>
          </fieldset>
          <Actions>
            <Button type="submit" disabled={action.busy !== null}>
              Make its key
            </Button>
            <Button quiet onClick={adding.done}>
              Cancel
            </Button>
          </Actions>
        </FormCard>
      )}

      {!data && !error && <Loading what="apps" />}
      {data && data.clients.length === 0 && !adding.open && !created && (
        <Empty>
          <p>No app reads Grenier yet: add it to one above.</p>
        </Empty>
      )}
      {data && data.clients.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th>App</th>
              <th>May read</th>
              <th>Created</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.clients.map((client) => (
              <tr key={client.name}>
                <td>
                  <span className="font-medium">{client.name}</span>
                </td>
                <td className="whitespace-normal">
                  {client.scopes.length > 0 ? (
                    <span className="inline-flex flex-wrap gap-1">
                      {client.scopes.map((scope) => (
                        <Tag key={scope}>{scope}</Tag>
                      ))}
                    </span>
                  ) : (
                    <span className="block text-sm break-all text-muted">repositories only</span>
                  )}
                </td>
                <td>
                  {new Date(client.createdAt).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </td>
                <td>
                  <div className="flex justify-end gap-1.5">
                    <ConfirmButton
                      label="Revoke"
                      question={`Revoke ${client.name}? Its next call fails.`}
                      disabled={action.busy !== null}
                      onConfirm={() =>
                        void action.run(`revoke:${client.name}`, async () => {
                          await api(`/clients/${encodeURIComponent(client.name)}/revoke`, { method: "POST" });
                          return { text: `Revoked ${client.name}.` };
                        })
                      }
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {data && data.clients.length > 0 && (
        <p className="mt-2 text-sm text-muted">
          An app added with its button reads every folder. To give it fewer, revoke it and make it a key below with only
          the folders it may read.
        </p>
      )}
    </Part>
  );
}
