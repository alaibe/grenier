import { useCallback, useState } from "react";
import { type AuditEntry, api } from "../api.ts";
import { Empty, Problem, Section, useLoad } from "../ui.tsx";

export function Audit() {
  const [client, setClient] = useState("");
  const load = useCallback(
    () => api<{ entries: AuditEntry[] }>(`/audit?since=30d${client ? `&client=${encodeURIComponent(client)}` : ""}`),
    [client],
  );
  const { data, error } = useLoad(load);

  return (
    <Section
      title="Every read, last 30 days"
      action={
        <label className="inline">
          Client
          <input value={client} onChange={(event) => setClient(event.target.value.trim())} placeholder="all" />
        </label>
      }
    >
      <Problem message={error} />
      {data && data.entries.length === 0 && <Empty>No reads of personal data.</Empty>}
      {data && data.entries.length > 0 && (
        <div className="scroll">
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
                  <td>{new Date(entry.ts).toLocaleString()}</td>
                  <td>{entry.client}</td>
                  <td>{entry.tool}</td>
                  <td className="args">{JSON.stringify(entry.args)}</td>
                  <td className="n" title={entry.itemIds.join("\n")}>
                    {entry.itemIds.length}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
