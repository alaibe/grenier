import { type FormEvent, useState } from "react";
import { api, type SourceView } from "../api.ts";
import { count, Empty, Problem, Section, useAction, useLoad, when } from "../ui.tsx";

const load = () => api<{ sources: SourceView[] }>("/sources");

const KINDS = {
  markdown: { where: "Folder", key: "path", placeholder: "/Users/you/Notes", secret: false },
  ics: { where: "File or URL", key: "url", placeholder: "https://… or /path/to/calendar.ics", secret: false },
  caldav: { where: "Server URL", key: "url", placeholder: "https://caldav.example.com", secret: true },
  imap: { where: "IMAP host", key: "host", placeholder: "imap.example.com", secret: true },
} as const;

type Kind = keyof typeof KINDS;

export function Sources() {
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);
  const [kind, setKind] = useState<Kind>("markdown");

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const where = String(form.get("where") ?? "").trim();
    const body: Record<string, unknown> = { kind, name: String(form.get("name") ?? "").trim() };
    if (kind === "ics") body[/^https?:\/\//.test(where) ? "url" : "path"] = where;
    else body[KINDS[kind].key] = where;
    if (KINDS[kind].secret) {
      body[kind === "caldav" ? "username" : "user"] = String(form.get("user") ?? "").trim();
      body.password_command = String(form.get("password") ?? "").trim();
    }
    const target = event.currentTarget;
    void action.run(async () => {
      await api("/sources", { body });
      target.reset();
    });
  };

  return (
    <>
      <Section title="Sources">
        <Problem message={error ?? action.error} />
        {data && data.sources.length === 0 && (
          <Empty>No sources yet. Add a notes folder, a calendar or a mailbox.</Empty>
        )}
        {data && data.sources.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th className="n">Items</th>
                  <th>Last sync</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.sources.map((source) => (
                  <tr key={source.name}>
                    <td>{source.name}</td>
                    <td>{source.kind}</td>
                    <td className="n">{count(source.items)}</td>
                    <td>{when(source.lastSync)}</td>
                    <td>
                      <div className="actions">
                        {source.kind !== "memory" && (
                          <>
                            <button
                              type="button"
                              disabled={action.busy}
                              onClick={() =>
                                void action.run(() =>
                                  api(`/sources/${encodeURIComponent(source.name)}/sync`, { method: "POST" }),
                                )
                              }
                            >
                              Sync
                            </button>
                            <button
                              type="button"
                              className="quiet"
                              disabled={action.busy}
                              onClick={() => {
                                if (confirm(`Remove ${source.name} and every item it brought?`)) {
                                  void action.run(() =>
                                    api(`/sources/${encodeURIComponent(source.name)}`, { method: "DELETE" }),
                                  );
                                }
                              }}
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Add a source">
        <form className="form" onSubmit={add}>
          <label>
            Kind
            <select value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
              <option value="markdown">Markdown folder</option>
              <option value="ics">Calendar file (ICS)</option>
              <option value="caldav">CalDAV calendar</option>
              <option value="imap">IMAP mailbox</option>
            </select>
          </label>
          <label>
            Name
            <input name="name" required pattern="[\w.@\-]+" placeholder="journal" />
          </label>
          <label className="wide">
            {KINDS[kind].where}
            <input name="where" required placeholder={KINDS[kind].placeholder} />
          </label>
          {KINDS[kind].secret && (
            <>
              <label>
                User
                <input name="user" required autoComplete="off" />
              </label>
              <label className="wide">
                Command printing the password
                <input name="password" required placeholder="security find-generic-password -s grenier-mail -w" />
              </label>
            </>
          )}
          <button type="submit" disabled={action.busy}>
            Add
          </button>
        </form>
        <p className="hint">Passwords are never stored: Grenier runs the command each time it syncs.</p>
      </Section>
    </>
  );
}
