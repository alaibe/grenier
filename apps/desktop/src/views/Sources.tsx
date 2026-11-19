import { type FormEvent, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type SourceSync, type SourceView } from "../api.ts";
import {
  ago,
  Button,
  ConfirmButton,
  count,
  Field,
  Input,
  Loading,
  type Message,
  Notice,
  Page,
  Select,
  Table,
  useAction,
  useLoad,
} from "../ui.tsx";

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
          <Button quiet onClick={() => setAdding(true)}>
            Add a source
          </Button>
        )
      }
    >
      <Notice message={error ?? action.message} />

      {formOpen && (
        <form
          className="mb-6 flex max-w-150 flex-col gap-3.5 rounded-xl border border-line bg-panel px-5 py-4.5"
          onSubmit={add}
        >
          <h2 className="font-semibold">Add a source</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              Kind
              <Select className="w-full" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                {(Object.keys(KINDS) as Kind[]).map((value) => (
                  <option key={value} value={value}>
                    {KINDS[value].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              Name
              <Input name="name" required pattern="[\w.@\-]+" placeholder="journal" autoComplete="off" />
            </Field>
          </div>
          <Field>
            {KINDS[kind].where}
            <Input name="where" required placeholder={KINDS[kind].placeholder} autoComplete="off" />
          </Field>
          {KINDS[kind].secret && (
            <>
              <Field>
                User
                <Input name="user" required autoComplete="off" />
              </Field>
              <Field>
                Command that prints the password
                <Input name="password" required placeholder="security find-generic-password -s grenier-mail -w" />
                <span className="text-sm font-normal text-muted">
                  Grenier never stores the password: it runs this command at each sync.
                </span>
              </Field>
            </>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={action.busy !== null}>
              {action.busy === "add" ? "Adding and syncing…" : "Add source"}
            </Button>
            {own.length > 0 && (
              <Button quiet onClick={() => setAdding(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}

      {!data && !error && <Loading what="sources" />}
      {data && data.sources.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th>Source</th>
              <th className="text-right tabular-nums">Items</th>
              <th>Synced</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((source) => (
              <tr key={source.name}>
                <td className="whitespace-normal">
                  <b className="font-semibold">{source.name}</b>
                  <span className="block text-sm break-all text-muted">
                    {[KIND_NAMES[source.kind] ?? source.kind, where(source)].filter(Boolean).join(" · ")}
                  </span>
                </td>
                <td className="text-right tabular-nums">{count(source.items)}</td>
                <td title={source.lastSync ? new Date(source.lastSync).toLocaleString() : undefined}>
                  {source.kind === "memory" ? "–" : ago(source.lastSync)}
                </td>
                <td>
                  {source.kind !== "memory" && (
                    <div className="flex justify-end gap-1.5">
                      <Button
                        quiet
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
                      </Button>
                      <ConfirmButton
                        label="Remove"
                        question={`Remove ${source.name} and every item it brought?`}
                        disabled={action.busy !== null}
                        onConfirm={() =>
                          void action.run(`remove:${source.name}`, async () => {
                            await api(`/sources/${encodeURIComponent(source.name)}`, { method: "DELETE" });
                            return { text: `Removed ${source.name}.` };
                          })
                        }
                      />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
