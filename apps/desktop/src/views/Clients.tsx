import { type FormEvent, useRef, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type ClientView } from "../api.ts";
import { Empty, Loading, Notice, Page, useAction, useLoad } from "../ui.tsx";

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
          <button type="button" className="quiet" onClick={() => setAdding(true)}>
            New client
          </button>
        )
      }
    >
      <Notice message={error ?? action.message} />

      {created && (
        <div className="panel token-panel" role="status">
          <h2>Token for {created.name}</h2>
          <p>
            Copy it now: it is shown only once. Give it to the app as <code>GRENIER_CLIENT_TOKEN</code> (stdio) or as{" "}
            <code>Authorization: Bearer</code> (HTTP).
          </p>
          <code className="token" ref={tokenText}>
            {created.token}
          </code>
          <div className="buttons">
            <button type="button" onClick={() => void copy(created.token)}>
              {copied ? "Copied" : "Copy token"}
            </button>
            <button type="button" className="quiet" onClick={() => setCreated(null)}>
              Done
            </button>
            {copied === false && <span className="hint">The token is selected: press ⌘C or Ctrl+C to copy it.</span>}
          </div>
        </div>
      )}

      {adding && (
        <form className="panel form" onSubmit={add}>
          <h2>New client</h2>
          <p className="hint">You get a token to give the app yourself. It is not installed anywhere.</p>
          <label>
            Name
            <input name="name" required pattern="[\w.@\-]+" placeholder="claude-desktop" autoComplete="off" />
          </label>
          <fieldset>
            <legend>May read</legend>
            <div className="choices">
              {(data?.scopes ?? []).map((scope) => (
                <label key={scope} className="choice">
                  <input type="checkbox" name="scope" value={scope} />
                  {scope}
                </label>
              ))}
            </div>
            <span className="hint">With nothing ticked, the client reads no personal data.</span>
          </fieldset>
          <div className="buttons">
            <button type="submit" disabled={action.busy !== null}>
              Create client
            </button>
            <button type="button" className="quiet" onClick={() => setAdding(false)}>
              Cancel
            </button>
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
        <div className="table">
          <table>
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
                    <b>{client.name}</b>
                  </td>
                  <td className="wrap">
                    {client.scopes.length > 0 ? (
                      <span className="tags">
                        {client.scopes.map((scope) => (
                          <span className="tag" key={scope}>
                            {scope}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="sub">no personal data</span>
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
                    <div className="actions">
                      <button
                        type="button"
                        className="quiet"
                        disabled={action.busy !== null}
                        onClick={() => {
                          if (confirm(`Revoke ${client.name}? Its next call fails.`)) {
                            void action.run(`revoke:${client.name}`, async () => {
                              await api(`/clients/${encodeURIComponent(client.name)}/revoke`, { method: "POST" });
                              return { text: `Revoked ${client.name}.` };
                            });
                          }
                        }}
                      >
                        Revoke
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.clients.length > 0 && (
        <p className="hint">
          To change what an app may read, run <code>grenier mcp install</code> for it again with the new{" "}
          <code>--scope</code>: its old token is revoked.
        </p>
      )}
    </Page>
  );
}
