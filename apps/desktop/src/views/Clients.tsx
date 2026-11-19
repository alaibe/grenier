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
  Page,
  Table,
  useAction,
  useLoad,
} from "../ui.tsx";

const load = () => api<{ clients: ClientView[]; scopes: string[] }>("/clients");

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
    <Page
      title="Clients and scopes"
      intro={
        <>
          Each app that reads your personal data through Grenier has its own token, and reads only the scopes you give
          it. <code>grenier mcp install</code> creates the client for the app it installs into; create one here only for
          another app or a script.
        </>
      }
      action={
        !adding && (
          <Button quiet onClick={() => setAdding(true)}>
            New client
          </Button>
        )
      }
    >
      <Notice message={error ?? action.message} />

      {created && (
        <div className="mb-6 rounded-xl border border-accent bg-panel px-5 py-4.5" role="status">
          <h2 className="font-semibold">Token for {created.name}</h2>
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
          <h2 className="font-semibold">New client</h2>
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
              With nothing ticked, the client reads no personal data.
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
          <p>No app reads your personal data yet. Install Grenier in one with the scopes it may read:</p>
          <code>grenier mcp install claude-desktop --scope notes,calendar</code>
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
                    <span className="block text-sm break-all text-muted">no personal data</span>
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
          To change what an app may read, run <code>grenier mcp install</code> for it again with the new{" "}
          <code>--scope</code>: its old token is revoked.
        </p>
      )}
    </Page>
  );
}
