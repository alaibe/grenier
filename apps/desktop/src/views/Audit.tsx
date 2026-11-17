import { useCallback, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { type AuditEntry, api, type ClientView } from "../api.ts";
import { Empty, Loading, moment, Notice, Page, useLoad } from "../ui.tsx";

const loadClients = () => api<{ clients: ClientView[] }>("/clients");

function asked(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

export function Audit(_: ViewProps) {
  const [client, setClient] = useState("");
  const clients = useLoad(loadClients);
  const load = useCallback(
    () => api<{ entries: AuditEntry[] }>(`/audit?since=30d${client ? `&client=${encodeURIComponent(client)}` : ""}`),
    [client],
  );
  const { data, error } = useLoad(load);

  return (
    <Page
      title="Audit log"
      intro="Every read of your personal data in the last 30 days, written before the client got an answer."
      action={
        <label className="filter">
          <span className="sr-only">Client</span>
          <select value={client} onChange={(event) => setClient(event.target.value)}>
            <option value="">All clients</option>
            {(clients.data?.clients ?? []).map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <Notice message={error} />
      {!data && !error && <Loading what="the audit log" />}
      {data && data.entries.length === 0 && (
        <Empty>{client ? `${client} has read no personal data.` : "No client has read personal data."}</Empty>
      )}
      {data && data.entries.length > 0 && (
        <div className="table">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Client</th>
                <th>Tool</th>
                <th>Asked</th>
                <th className="n">Items</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{moment(entry.ts)}</td>
                  <td>{entry.client}</td>
                  <td>{entry.tool}</td>
                  <td className="fill" title={asked(entry.args)}>
                    {asked(entry.args)}
                  </td>
                  <td className="n" title={entry.itemIds.join("\n")}>
                    {entry.itemIds.length}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
