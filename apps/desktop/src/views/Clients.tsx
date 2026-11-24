import { type FormEvent, useRef, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type ClientView } from "../api.ts";
import {
  Button,
  ConfirmButton,
  Empty,
  Field,
  Input,
  Loading,
  Notice,
  Part,
  Table,
  useAction,
  useLoad,
} from "../ui.tsx";

const load = () => api<{ clients: ClientView[]; scopes: string[] }>("/clients");
const loadApps = () =>
  api<{ apps: { app: string; label: string; connected: boolean }[] }>("/apps").then((answer) => answer.apps);

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

export function Clients(_: ViewProps) {
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const tokenText = useRef<HTMLElement>(null);

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const scopes = form.getAll("scope").map(String);
    void action
      .run("create", async () => {
        const result = await api<{ token: string }>("/clients", { body: { name, scopes } });
        setCreated({ name, token: result.token });
        setCopied(null);
        return undefined;
      })
      .then((done) => {
        if (done) setAdding(false);
      });
  };

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      const selection = getSelection();
      if (!tokenText.current || !selection) return setCopied(false);
      selection.selectAllChildren(tokenText.current);
      setCopied(document.execCommand("copy"));
    }
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
      action={
        !adding && (
          <Button quiet onClick={() => setAdding(true)}>
            Another app
          </Button>
        )
      }
    >
      <Connect added={reload} />
      <Notice message={error ?? action.message} />

      {created && (
        <div className="mb-6 rounded-xl border border-accent bg-panel px-5 py-4.5" role="status">
          <h3 className="font-semibold">Token for {created.name}</h3>
          <p className="mt-1.5">
            Copy it now: it is shown only once. Give it to the app as <code>GRENIER_CLIENT_TOKEN</code> (stdio) or as{" "}
            <code>Authorization: Bearer</code> (HTTP).
          </p>
          <code
            className="mt-3 mb-3.5 block border border-line bg-bg px-3 py-2.5 text-md whitespace-normal break-all select-all"
            ref={tokenText}
          >
            {created.token}
          </code>
          <div className="flex items-center gap-2">
            <Button onClick={() => void copy(created.token)}>{copied ? "Copied" : "Copy token"}</Button>
            <Button quiet onClick={() => setCreated(null)}>
              Done
            </Button>
            {copied === false && (
              <span className="text-sm font-normal text-muted">
                The token is selected: press ⌘C or Ctrl+C to copy it.
              </span>
            )}
          </div>
        </div>
      )}

      {adding && (
        <form
          className="mb-6 flex max-w-150 flex-col gap-3.5 rounded-xl border border-line bg-panel px-5 py-4.5"
          onSubmit={add}
        >
          <h3 className="font-semibold">New client</h3>
          <p className="text-sm font-normal text-muted">
            You get a token to give the app yourself. It is not installed anywhere.
          </p>
          <Field>
            Name
            <Input name="name" required pattern="[\w.@\-]+" placeholder="claude-desktop" autoComplete="off" />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-md font-medium">May read</legend>
            <div className="flex flex-wrap gap-1.5">
              {(data?.scopes ?? []).map((scope) => (
                <label
                  key={scope}
                  className="flex cursor-pointer items-center gap-1.75 rounded-md border border-line-strong px-2.5 py-1.5"
                >
                  <input type="checkbox" className="accent-accent" name="scope" value={scope} />
                  {scope}
                </label>
              ))}
            </div>
            <span className="text-sm font-normal text-muted">
              With nothing ticked, it reads only the repositories' folders. * is every top folder.
            </span>
          </fieldset>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={action.busy !== null}>
              Create client
            </Button>
            <Button quiet onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {!data && !error && <Loading what="clients" />}
      {data && data.clients.length === 0 && !adding && !created && (
        <Empty>
          <p>No app reads Grenier yet: add it to one above.</p>
        </Empty>
      )}
      {data && data.clients.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th>Client</th>
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
                  <b className="font-semibold">{client.name}</b>
                </td>
                <td className="whitespace-normal">
                  {client.scopes.length > 0 ? (
                    <span className="inline-flex flex-wrap gap-1">
                      {client.scopes.map((scope) => (
                        <span className="rounded-[5px] border border-line-strong px-1.75 text-xs leading-5" key={scope}>
                          {scope}
                        </span>
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
        <p className="mt-2 text-sm font-normal text-muted">
          An app added with its button reads every folder. To give it fewer, revoke it and make it a key below with only
          the folders it may read.
        </p>
      )}
    </Part>
  );
}
