import { type FormEvent, useState } from "react";
import { api, type ClientView } from "../api.ts";
import { Empty, Problem, Section, useAction, useLoad, when } from "../ui.tsx";

const load = () => api<{ clients: ClientView[]; scopes: string[] }>("/clients");

export function Clients() {
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const scopes = form.getAll("scope").map(String);
    const target = event.currentTarget;
    void action.run(async () => {
      const result = await api<{ token: string }>("/clients", { body: { name, scopes } });
      setCreated({ name, token: result.token });
      target.reset();
    });
  };

  return (
    <>
      <Section title="Clients and scopes">
        <Problem message={error ?? action.error} />
        {created && (
          <div className="notice" role="status">
            <p>
              Token for <b>{created.name}</b>, shown once. Give it to the app as GRENIER_CLIENT_TOKEN (stdio) or
              Authorization: Bearer (HTTP).
            </p>
            <code className="token">{created.token}</code>
            <button type="button" className="quiet" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        )}
        {data && data.clients.length === 0 && <Empty>No clients yet.</Empty>}
        {data && data.clients.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>May read</th>
                  <th>Since</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.clients.map((client) => (
                  <tr key={client.name}>
                    <td>{client.name}</td>
                    <td>{client.scopes.length > 0 ? client.scopes.join(", ") : "no personal data"}</td>
                    <td>{when(client.createdAt)}</td>
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          className="quiet"
                          disabled={action.busy}
                          onClick={() => {
                            if (confirm(`Revoke ${client.name}? Its next call fails.`)) {
                              void action.run(() =>
                                api(`/clients/${encodeURIComponent(client.name)}/revoke`, { method: "POST" }),
                              );
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
      </Section>

      <Section title="New client">
        <form className="form" onSubmit={add}>
          <label>
            Name
            <input name="name" required pattern="[\w.@\-]+" placeholder="claude-desktop" />
          </label>
          <fieldset className="wide">
            <legend>May read</legend>
            {(data?.scopes ?? []).map((scope) => (
              <label key={scope} className="check">
                <input type="checkbox" name="scope" value={scope} /> {scope}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={action.busy}>
            Create
          </button>
        </form>
      </Section>
    </>
  );
}
