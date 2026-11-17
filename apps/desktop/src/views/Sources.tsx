import { type FormEvent, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type SourceSync, type SourceView } from "../api.ts";
import { ago, count, Loading, type Message, Notice, Page, useAction, useLoad } from "../ui.tsx";

const load = () => api<{ sources: SourceView[] }>("/sources");

const KINDS = {
  markdown: {
    label: "Notes folder (Markdown)",
    where: "Folder",
    key: "path",
    placeholder: "/Users/you/Notes",
    secret: false,
  },
  ics: {
    label: "Calendar file (ICS)",
    where: "File or URL",
    key: "url",
    placeholder: "https://… or /path/to/calendar.ics",
    secret: false,
  },
  caldav: {
    label: "CalDAV calendar",
    where: "Server URL",
    key: "url",
    placeholder: "https://caldav.example.com",
    secret: true,
  },
  imap: { label: "IMAP mailbox", where: "IMAP host", key: "host", placeholder: "imap.example.com", secret: true },
} as const;

type Kind = keyof typeof KINDS;

const KIND_NAMES: Record<string, string> = {
  markdown: "Notes folder",
  ics: "Calendar file",
  caldav: "CalDAV calendar",
  imap: "Mailbox",
  memory: "Memories approved in the review queue",
};

function where(source: SourceView): string {
  const text = (key: string) => (typeof source.config[key] === "string" ? (source.config[key] as string) : "");
  if (source.kind === "imap") return [text("user"), text("host")].filter(Boolean).join("@");
  return text("path") || text("url");
}

function synced(sync: SourceSync | null, done: string, failed: string): Message {
  if (sync?.error) return { text: `${failed}: ${sync.error}`, problem: true };
  if (!sync) return { text: `${done}.` };
  return { text: `${done}: ${count(sync.added)} items added, ${count(sync.removed)} removed.` };
}

export function Sources(_: ViewProps) {
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);
  const [kind, setKind] = useState<Kind>("markdown");
  const [adding, setAdding] = useState(false);
  const own = data?.sources.filter((source) => source.kind !== "memory") ?? [];
  const formOpen = adding || (data !== null && own.length === 0);

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const place = String(form.get("where") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const body: Record<string, unknown> = { kind, name };
    if (kind === "ics") body[/^https?:\/\//.test(place) ? "url" : "path"] = place;
    else body[KINDS[kind].key] = place;
    if (KINDS[kind].secret) {
      body[kind === "caldav" ? "username" : "user"] = String(form.get("user") ?? "").trim();
      body.password_command = String(form.get("password") ?? "").trim();
    }
    const target = event.currentTarget;
    void action
      .run("add", async () => {
        const result = await api<{ sync: SourceSync | null }>("/sources", { body });
        return synced(result.sync, `Added ${name}`, `Added ${name}, but its first sync failed`);
      })
      .then((done) => {
        if (done) {
          target.reset();
          setAdding(false);
        }
      });
  };

  return (
    <Page
      title="Sources"
      intro="The notes, calendars and mail Grenier indexes on this machine. A client reads one only with its scope."
      action={
        !formOpen && (
          <button type="button" className="quiet" onClick={() => setAdding(true)}>
            Add a source
          </button>
        )
      }
    >
      <Notice message={error ?? action.message} />

      {formOpen && (
        <form className="panel form" onSubmit={add}>
          <h2>Add a source</h2>
          <div className="row">
            <label>
              Kind
              <select value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                {(Object.keys(KINDS) as Kind[]).map((value) => (
                  <option key={value} value={value}>
                    {KINDS[value].label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name
              <input name="name" required pattern="[\w.@\-]+" placeholder="journal" autoComplete="off" />
            </label>
          </div>
          <label>
            {KINDS[kind].where}
            <input name="where" required placeholder={KINDS[kind].placeholder} autoComplete="off" />
          </label>
          {KINDS[kind].secret && (
            <>
              <label>
                User
                <input name="user" required autoComplete="off" />
              </label>
              <label>
                Command that prints the password
                <input name="password" required placeholder="security find-generic-password -s grenier-mail -w" />
                <span className="hint">Grenier never stores the password: it runs this command at each sync.</span>
              </label>
            </>
          )}
          <div className="buttons">
            <button type="submit" disabled={action.busy !== null}>
              {action.busy === "add" ? "Adding and syncing…" : "Add source"}
            </button>
            {own.length > 0 && (
              <button type="button" className="quiet" onClick={() => setAdding(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {!data && !error && <Loading what="sources" />}
      {data && data.sources.length > 0 && (
        <div className="table">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th className="n">Items</th>
                <th>Synced</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((source) => (
                <tr key={source.name}>
                  <td className="wrap">
                    <b>{source.name}</b>
                    <span className="sub">
                      {[KIND_NAMES[source.kind] ?? source.kind, where(source)].filter(Boolean).join(" · ")}
                    </span>
                  </td>
                  <td className="n">{count(source.items)}</td>
                  <td title={source.lastSync ? new Date(source.lastSync).toLocaleString() : undefined}>
                    {source.kind === "memory" ? "–" : ago(source.lastSync)}
                  </td>
                  <td>
                    {source.kind !== "memory" && (
                      <div className="actions">
                        <button
                          type="button"
                          className="quiet"
                          disabled={action.busy !== null}
                          onClick={() =>
                            void action.run(`sync:${source.name}`, async () => {
                              const result = await api<{ sync: SourceSync }>(
                                `/sources/${encodeURIComponent(source.name)}/sync`,
                                { method: "POST" },
                              );
                              return synced(result.sync, `Synced ${source.name}`, `Could not sync ${source.name}`);
                            })
                          }
                        >
                          {action.busy === `sync:${source.name}` ? "Syncing…" : "Sync"}
                        </button>
                        <button
                          type="button"
                          className="quiet"
                          disabled={action.busy !== null}
                          onClick={() => {
                            if (confirm(`Remove ${source.name} and every item it brought?`)) {
                              void action.run(`remove:${source.name}`, async () => {
                                await api(`/sources/${encodeURIComponent(source.name)}`, { method: "DELETE" });
                                return { text: `Removed ${source.name}.` };
                              });
                            }
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    )}
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
