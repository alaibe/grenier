import type {
  Conflict,
  Created,
  Editors,
  FileVersions,
  HistoryEntry,
  Link,
  LinkedRecord,
  RecordFull,
  RecordRow,
  Saved,
  TeamRecord,
  Top,
} from "@grenier/core/api";
import { topName } from "@grenier/core/team";
import { Check, Undo2, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api.ts";
import { hunks, lineDiff } from "../diff.ts";
import { Markdown } from "../markdown.tsx";
import {
  Actions,
  ago,
  Button,
  Card,
  ConfirmButton,
  Empty,
  List,
  Loading,
  type Message,
  moment,
  Notice,
  panel,
  Row,
  Section,
  Select,
  Textarea,
  Toggle,
  useAction,
  useLoad,
} from "../ui.tsx";

interface Draft {
  top: string;
  folder: string;
  title: string;
  body: string;
  links: Link[];
}

/** What a page editor opens: a page, or a new one in a folder. */
export type Target = { id: string } | { top: string; folder: string };

/** Where a page can go: the top of a top folder this machine writes to, or a folder in it, with its folder path. */
export interface FolderPath {
  top: string;
  folder: string;
  label: string;
}

export const folderPathKey = (path: { top: string; folder: string }) => `${path.top}\u0000${path.folder}`;

export function PageEditor({
  target,
  folderPaths,
  tops,
  member,
  open,
  changed,
  closed,
}: {
  target: Target;
  folderPaths: FolderPath[];
  tops: Top[];
  member: boolean;
  open: (id: string) => void;
  /** After a save or a move: the tree reloads. */
  changed: () => void;
  /** After it is retired. */
  closed: () => void;
}) {
  const id = "id" in target ? target.id : null;
  const load = useCallback(
    () => (id ? api<RecordFull>(`/records/${encodeURIComponent(id)}`) : Promise.resolve(null)),
    [id],
  );
  const record = useLoad(load);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState(0);
  const [conflict, setConflict] = useState<TeamRecord | null>(null);
  const action = useAction(() => {});

  useEffect(() => {
    if (draft) return;
    if (record.data) {
      const { top, folder, title, body, links, version } = record.data;
      setDraft({ top, folder, title, body, links });
      setBase(version);
    } else if (!id && "top" in target) {
      setDraft({ top: target.top, folder: target.folder, title: "", body: "", links: [] });
    }
  }, [draft, record.data, id, target]);

  const save = (version = base) =>
    void action.run("save", async (): Promise<Message> => {
      if (!draft) return { text: "Nothing to save." };
      try {
        if (!id) {
          const created = await api<Created>("/records", { body: { ...draft, type: "Doc" } });
          changed();
          open(created.id);
          return { text: "Saved." };
        }
        const saved = await api<Saved>(`/records/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: { ...draft, baseVersion: version },
        });
        setConflict(null);
        record.reload();
        setDraft(null);
        changed();
        if (!saved.waiting) return { text: "Saved and shared." };
        return { text: saved.team ? "Saved here; it goes to the team at the next sync." : "Saved on this machine." };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.body && typeof error.body === "object") {
          const current = (error.body as Partial<Conflict>).conflict;
          if (current) {
            setConflict(current);
            return { text: "Someone changed this page since you opened it.", problem: true };
          }
        }
        throw error;
      }
    });

  const take = (theirs: TeamRecord) => {
    setDraft({
      top: theirs.top,
      folder: theirs.folder,
      title: theirs.title,
      body: theirs.body,
      links: theirs.links,
    });
    setBase(theirs.version);
    setConflict(null);
  };

  if (record.error) return <Notice message={record.error} />;
  if (!draft) return <Loading what="the page" />;
  const set = (change: Partial<Draft>) => setDraft({ ...draft, ...change });
  const here = { top: draft.top, folder: draft.folder };
  const kindOf = (top: string) => tops.find((entry) => entry.id === top)?.kind;
  // A member writes in Me, and their agents' answers where they are; the team store refuses the rest.
  const from = record.data?.top ?? draft.top;
  const answer = record.data?.type === "Memory" && kindOf(from) === "repo";
  const writes = (top: string) => !member || kindOf(top) === "me" || (answer && top === from);
  const editable = writes(from);
  const allowed = folderPaths.filter((path) => writes(path.top));
  const choices = allowed.some((path) => folderPathKey(path) === folderPathKey(here))
    ? allowed
    : [...allowed, { ...here, label: folderPath(tops, draft.top, draft.folder) }];
  const kind =
    record.data && record.data.type !== "Doc"
      ? `${record.data.type}${record.data.kind ? ` · ${record.data.kind}` : ""} · `
      : "";

  return (
    <article>
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Select
            className="mb-2 max-w-full text-sm"
            aria-label="Folder"
            disabled={!editable}
            value={folderPathKey(here)}
            onChange={(event) => {
              const path = choices.find((entry) => folderPathKey(entry) === event.currentTarget.value);
              if (path) set({ top: path.top, folder: path.folder });
            }}
          >
            {choices.map((path) => (
              <option key={folderPathKey(path)} value={folderPathKey(path)}>
                {path.label}
              </option>
            ))}
          </Select>
          <input
            className="w-full bg-transparent font-mono text-2xl leading-[1.2] font-semibold outline-none placeholder:text-muted"
            aria-label="Title"
            placeholder="Untitled"
            readOnly={!editable}
            value={draft.title}
            onChange={(event) => set({ title: event.currentTarget.value })}
          />
          {record.data && (
            <p className="mt-1.5 text-sm text-muted">
              {kind}by {record.data.author} on {record.data.device} · changed {ago(record.data.updatedAt)}
              {record.data.hits > 0 && ` · used ${record.data.hits} times`}
            </p>
          )}
        </div>
        <div className={`flex items-center gap-2 pt-8 ${editable ? "" : "hidden"}`}>
          {record.data && !record.data.retiredAt && (
            <ConfirmButton
              label="Retire"
              question={draft.top === "me" ? "Retire it?" : "Retire it for everyone who reads it?"}
              disabled={action.busy !== null}
              onConfirm={() =>
                void action.run("retire", async () => {
                  await api(`/records/${encodeURIComponent(record.data?.id ?? "")}`, { method: "DELETE" });
                  changed();
                  closed();
                  return undefined;
                })
              }
            />
          )}
          <Button disabled={action.busy !== null} onClick={() => save()}>
            {action.busy === "save" ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>
      <Notice message={action.message} />
      {!editable && <p className="mb-4 text-sm text-muted">Only an admin changes the pages here.</p>}
      {id && <Presence id={id} />}
      {conflict && (
        <Card tone="problem" aria-label="Their version">
          <p className="font-medium">
            {conflict.author} saved version {conflict.version} while you were editing.
          </p>
          <p className="mt-1 text-sm">
            Theirs: <span className="font-medium">{conflict.title}</span>
            {conflict.body !== draft.body && " — the text differs"}
          </p>
          <Actions className="mt-2.5">
            <Button onClick={() => save(conflict.version)}>Keep mine</Button>
            <Button quiet onClick={() => take(conflict)}>
              Take theirs
            </Button>
          </Actions>
        </Card>
      )}
      {record.data?.retiredAt && <Notice message={`Retired ${ago(record.data.retiredAt)}.`} />}
      {record.data?.type === "Suggestion" && <SuggestionActions record={record.data} back={closed} />}

      <Body
        editable={editable}
        text={draft.body}
        onChange={(body, link) =>
          set({ body, ...(link ? { links: [...draft.links.filter((entry) => entry.ref !== link.ref), link] } : {}) })
        }
        open={open}
      />

      {record.data && (
        <>
          <Anchors record={record.data} />
          <Linked title="Links to" items={record.data.linksTo} open={open} />
          <Linked title="Linked from" items={record.data.linkedFrom} open={open} />
          <History id={record.data.id} restore={(snapshot) => set(snapshot)} />
        </>
      )}
    </article>
  );
}

/** A folder path as the editor shows it, "Team / Decisions / 2026": a top folder's name, then the folders in it. */
export function folderPath(tops: Top[], top: string, folder: string): string {
  const named = tops.find((entry) => entry.id === top);
  return [named ? topName(named) : top, ...(folder ? folder.split("/") : [])].join(" / ");
}

/** The text: Markdown, with @ to link another page. */
function Body({
  editable,
  text,
  onChange,
  open,
}: {
  editable: boolean;
  text: string;
  onChange: (body: string, link?: Link) => void;
  open: (id: string) => void;
}) {
  const [writing, setWriting] = useState(() => text.trim() === "");
  const preview = !editable || !writing;
  const [mention, setMention] = useState<{ word: string; start: number } | null>(null);
  const [matches, setMatches] = useState<RecordRow[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!mention || mention.word.length < 2) {
      setMatches([]);
      return;
    }
    let current = true;
    api<{ records: RecordRow[] }>(`/records?q=${encodeURIComponent(mention.word)}`)
      .then((answer) => current && setMatches(answer.records.slice(0, 6)))
      .catch(() => current && setMatches([]));
    return () => {
      current = false;
    };
  }, [mention]);

  const look = (value: string, caret: number) => {
    const found = /(^|\s)@([^\s@][^@\n]{0,40})?$/.exec(value.slice(0, caret));
    setMention(found ? { word: found[2] ?? "", start: caret - (found[2] ?? "").length - 1 } : null);
  };

  const insert = (start: number, end: number, replacement: string, link: Link) => {
    onChange(`${text.slice(0, start)}${replacement}${text.slice(end)}`, link);
    setMention(null);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(start + replacement.length, start + replacement.length);
    });
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") setMention(null);
  };

  return (
    <section className="mb-7">
      <div className={`mb-1.5 flex justify-end ${editable ? "" : "hidden"}`}>
        <Toggle
          label="Text view"
          options={[
            ["write", "Write"],
            ["preview", "Preview"],
          ]}
          value={preview ? "preview" : "write"}
          onChange={(view) => setWriting(view === "write")}
        />
      </div>
      {preview && !text.trim() && <Empty>Nothing written.</Empty>}
      {preview && text.trim() && (
        <Card className="min-h-40">
          <Markdown text={text} open={open} />
        </Card>
      )}
      {!preview && (
        <div className="relative">
          <Textarea
            ref={area}
            mono
            className="min-h-96"
            aria-label="Text, in Markdown"
            placeholder="Markdown. @ links another page."
            value={text}
            onChange={(event) => {
              onChange(event.currentTarget.value);
              look(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onKeyDown={keyDown}
            onBlur={() => setTimeout(() => setMention(null), 150)}
          />
          {mention && matches.length > 0 && (
            <ul className="absolute right-3 bottom-3 z-10 w-80 rounded-lg border border-line-strong bg-panel py-1 shadow-lg">
              {matches.map((match) => (
                <li key={match.id}>
                  <button
                    type="button"
                    className="w-full cursor-pointer px-3 py-1.5 text-left hover:bg-hover"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insert(
                        mention.start,
                        mention.start + mention.word.length + 1,
                        `[${match.title}](record:${match.id})`,
                        {
                          kind: "record",
                          ref: match.id,
                        },
                      );
                    }}
                  >
                    {match.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function Anchors({ record }: { record: RecordFull }) {
  const files = record.anchors.filter((anchor) => anchor.kind === "git");
  const [shown, setShown] = useState<string | null>(null);
  if (files.length === 0) return null;
  return (
    <Section title="Written from">
      <List>
        {files.map((anchor) => (
          <Row
            key={anchor.ref}
            title={<code>{anchor.ref}</code>}
            actions={
              record.changed.includes(anchor.ref) ? (
                <button
                  type="button"
                  className="cursor-pointer text-sm text-danger underline underline-offset-2"
                  onClick={() => setShown(shown === anchor.ref ? null : anchor.ref)}
                >
                  {shown === anchor.ref ? "Hide the change" : "Changed since: show"}
                </button>
              ) : (
                <span className="text-sm text-muted">
                  {record.status === "unchecked" ? "not on this machine" : "unchanged"}
                </span>
              )
            }
          >
            {shown === anchor.ref && <FileDiff id={record.id} path={anchor.ref} />}
          </Row>
        ))}
      </List>
    </Section>
  );
}

function FileDiff({ id, path }: { id: string; path: string }) {
  const load = useCallback(
    () => api<FileVersions>(`/records/${encodeURIComponent(id)}/diff?path=${encodeURIComponent(path)}`),
    [id, path],
  );
  const { data, error } = useLoad(load);
  if (error) return <Notice message={error} />;
  if (!data) return <Loading what="the change" />;
  if (data.now === null) return <p className="mt-2 text-sm text-muted">The file is gone.</p>;
  if (data.before === null)
    return <p className="mt-2 text-sm text-muted">The version it was written from is not here.</p>;
  const lines = lineDiff(data.before, data.now);
  if (!lines) return <p className="mt-2 text-sm text-muted">Too large a change to show here.</p>;
  return (
    <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-side py-2 font-mono text-xs leading-5">
      {hunks(lines).map((line, n) =>
        line === null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a diff have no other identity
          <div key={n} className="px-3 text-muted">
            ⋯
          </div>
        ) : (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a diff have no other identity
            key={n}
            className={`px-3 ${line.kind === "new" ? "bg-success/12 text-success" : line.kind === "gone" ? "bg-danger/12 text-danger" : ""}`}
          >
            {line.kind === "new" ? "+ " : line.kind === "gone" ? "- " : "  "}
            {line.text}
          </div>
        ),
      )}
    </pre>
  );
}

function Linked({ title, items, open }: { title: string; items: LinkedRecord[]; open: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="cursor-pointer rounded-md border border-line-strong bg-panel px-2.5 py-1 hover:bg-hover"
              onClick={() => open(item.id)}
            >
              {item.title} <span className="text-sm text-muted">{item.type}</span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function History({ id, restore }: { id: string; restore: (draft: Partial<Draft>) => void }) {
  const [shown, setShown] = useState(false);
  const load = useCallback(
    () =>
      shown
        ? api<{ history: HistoryEntry[] }>(`/records/${encodeURIComponent(id)}/history`).then((a) => a.history)
        : Promise.resolve(null),
    [id, shown],
  );
  const { data, error } = useLoad(load);
  return (
    <Section
      title={
        <button
          type="button"
          className="cursor-pointer hover:underline"
          aria-expanded={shown}
          onClick={() => setShown(!shown)}
        >
          History {shown ? "▾" : "▸"}
        </button>
      }
    >
      {shown && <Notice message={error} />}
      {shown && data?.length === 0 && <Empty>No earlier version.</Empty>}
      {shown && data && data.length > 0 && (
        <ol className={panel()}>
          {[...data].reverse().map((entry) => (
            <li
              key={entry.version}
              className="flex items-center justify-between gap-4 border-t border-line px-4 py-2 first:border-t-0"
            >
              <span>
                Version {entry.version}, by {entry.author}
                {entry.device ? ` on ${entry.device}` : ""}, {moment(entry.ts)}
                {entry.snapshot.title ? ` — ${entry.snapshot.title}` : ""}
              </span>
              <Button
                icon={Undo2}
                quiet
                onClick={() =>
                  restore({
                    ...(typeof entry.snapshot.title === "string" ? { title: entry.snapshot.title } : {}),
                    ...(typeof entry.snapshot.body === "string" ? { body: entry.snapshot.body } : {}),
                  })
                }
              >
                Restore
              </Button>
            </li>
          ))}
        </ol>
      )}
      {shown && data && data.length > 0 && (
        <p className="mt-1.5 text-sm text-muted">Restore puts that version in the form; Save makes it the latest.</p>
      )}
    </Section>
  );
}

/** Who else has the record open, told every few seconds by the team store. */
function Presence({ id }: { id: string }) {
  const [others, setOthers] = useState<Editors["others"]>([]);
  useEffect(() => {
    let current = true;
    const tell = () => {
      if (document.hidden) return;
      api<Editors>(`/team/records/${encodeURIComponent(id)}/open`, {
        method: "PUT",
        body: {},
      })
        .then((answer) => current && setOthers(answer.others))
        .catch(() => current && setOthers([]));
    };
    tell();
    const timer = window.setInterval(tell, 15_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [id]);
  if (others.length === 0) return null;
  return (
    <Notice
      message={{
        text: `Also open: ${others.map((other) => `${other.member} on ${other.device}`).join(", ")}. The second save is asked to choose.`,
      }}
    />
  );
}

/** A suggestion of the librarian: accepted, its change goes into the record it names; either way it is retired. */
function SuggestionActions({ record, back }: { record: RecordFull; back: () => void }) {
  const action = useAction(() => {});
  const target = String(record.fields.target ?? "");
  const change = (record.fields.change ?? {}) as Record<string, unknown>;
  const decide = (accept: boolean) =>
    void action.run(accept ? "accept" : "dismiss", async () => {
      if (accept && change.retire === true) {
        await api(`/records/${encodeURIComponent(target)}`, { method: "DELETE" });
      } else if (accept) {
        const current = await api<RecordFull>(`/records/${encodeURIComponent(target)}`);
        await api(`/records/${encodeURIComponent(target)}`, {
          method: "PUT",
          body: {
            ...change,
            ...(change.fields ? { fields: { ...current.fields, ...(change.fields as object) } } : {}),
            baseVersion: current.version,
          },
        });
      }
      await api(`/records/${encodeURIComponent(record.id)}`, { method: "DELETE" });
      back();
      return undefined;
    });
  return (
    <Card tone="soft">
      <p>{String(record.fields.reason ?? "")}</p>
      <pre className="mt-2 overflow-x-auto font-mono text-xs">{JSON.stringify(change, null, 2)}</pre>
      <Notice message={action.message} />
      <Actions className="mt-2.5">
        <Button icon={Check} disabled={action.busy !== null} onClick={() => decide(true)}>
          Accept
        </Button>
        <Button quiet icon={X} disabled={action.busy !== null} onClick={() => decide(false)}>
          Dismiss
        </Button>
      </Actions>
    </Card>
  );
}
