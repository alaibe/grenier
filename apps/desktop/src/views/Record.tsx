import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type HistoryEntry, type Link, type RecordFull, type RecordRow, type Top } from "../api.ts";
import { hunks, lineDiff } from "../diff.ts";
import { Markdown } from "../markdown.tsx";
import {
  ago,
  Button,
  ConfirmButton,
  Loading,
  type Message,
  moment,
  Notice,
  Select,
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

/** Where a page can go: the top of each top folder this machine writes to, and every folder in them. */
export interface Place {
  top: string;
  folder: string;
  label: string;
}

export const placeKey = (place: { top: string; folder: string }) => `${place.top}\u0000${place.folder}`;

export function PageEditor({
  target,
  places,
  tops,
  member,
  open,
  changed,
  closed,
}: {
  target: Target;
  places: Place[];
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
  const [conflict, setConflict] = useState<RecordFull | null>(null);
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
          const created = await api<{ id: string }>("/records", { body: { ...draft, type: "Doc" } });
          changed();
          open(created.id);
          return { text: "Saved." };
        }
        const saved = await api<{ waiting?: boolean; team?: boolean }>(`/records/${encodeURIComponent(id)}`, {
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
          const current = (error.body as { conflict?: RecordFull }).conflict;
          if (current) {
            setConflict(current);
            return { text: "Someone changed this page since you opened it.", problem: true };
          }
        }
        throw error;
      }
    });

  const take = (theirs: RecordFull) => {
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
  const allowed = places.filter((place) => writes(place.top));
  const choices = allowed.some((place) => placeKey(place) === placeKey(here))
    ? allowed
    : [...allowed, { ...here, label: placeLabel(tops, draft.top, draft.folder) }];
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
            value={placeKey(here)}
            onChange={(event) => {
              const place = choices.find((entry) => placeKey(entry) === event.currentTarget.value);
              if (place) set({ top: place.top, folder: place.folder });
            }}
          >
            {choices.map((place) => (
              <option key={placeKey(place)} value={placeKey(place)}>
                {place.label}
              </option>
            ))}
          </Select>
          <input
            className="w-full bg-transparent font-serif text-4xl leading-[1.2] font-semibold outline-none placeholder:text-muted"
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
        <section className="mb-5 rounded-xl border border-problem bg-problem-soft px-4 py-3" aria-label="Their version">
          <p className="font-medium">
            {conflict.author} saved version {conflict.version} while you were editing.
          </p>
          <p className="mt-1 text-sm">
            Theirs: <b className="font-semibold">{conflict.title}</b>
            {conflict.body !== draft.body && " — the text differs"}
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button onClick={() => save(conflict.version)}>Keep mine</Button>
            <Button quiet onClick={() => take(conflict)}>
              Take theirs
            </Button>
          </div>
        </section>
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

/** "Team / Decisions / 2026": a top folder's name, then the folder's path. */
export function placeLabel(tops: Top[], top: string, folder: string): string {
  return [topName(tops, top), ...(folder ? folder.split("/") : [])].join(" / ");
}

export function topName(tops: Top[], id: string): string {
  const top = tops.find((entry) => entry.id === id);
  if (!top) return id;
  if (top.kind === "me") return "Me";
  if (top.kind === "team") return "Team";
  return top.name;
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
    <section className="mb-6">
      <div className={`mb-1.5 flex justify-end ${editable ? "" : "hidden"}`}>
        <fieldset className="inline-flex overflow-hidden rounded-md border border-line-strong text-sm">
          <legend className="sr-only">Text view</legend>
          {(["Write", "Preview"] as const).map((name) => (
            <button
              type="button"
              key={name}
              aria-pressed={preview === (name === "Preview")}
              className={`h-7 cursor-pointer px-2.5 ${preview === (name === "Preview") ? "bg-accent text-accent-fg" : "bg-panel hover:bg-hover"}`}
              onClick={() => setWriting(name === "Write")}
            >
              {name}
            </button>
          ))}
        </fieldset>
      </div>
      {preview ? (
        <div className="min-h-40 rounded-xl border border-line bg-panel px-4 py-3">
          {text.trim() ? <Markdown text={text} open={open} /> : <p className="text-muted">Nothing written.</p>}
        </div>
      ) : (
        <div className="relative">
          <textarea
            ref={area}
            className="min-h-96 w-full rounded-xl border border-line-strong bg-panel px-4 py-3 font-mono text-md leading-relaxed"
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
    <section className="mb-6">
      <h2 className="mb-1.5 font-semibold">Written from</h2>
      <ul className="rounded-xl border border-line bg-panel">
        {files.map((anchor) => {
          const changed = record.changed.includes(anchor.ref);
          return (
            <li key={anchor.ref} className="border-t border-line px-4 py-2 first:border-t-0">
              <div className="flex items-center justify-between gap-3">
                <code className="font-mono text-sm">{anchor.ref}</code>
                {changed ? (
                  <button
                    type="button"
                    className="cursor-pointer text-sm text-problem underline underline-offset-2"
                    onClick={() => setShown(shown === anchor.ref ? null : anchor.ref)}
                  >
                    {shown === anchor.ref ? "Hide the change" : "Changed since: show"}
                  </button>
                ) : (
                  <span className="text-sm text-muted">
                    {record.status === "unchecked" ? "not on this machine" : "unchanged"}
                  </span>
                )}
              </div>
              {shown === anchor.ref && <FileDiff id={record.id} path={anchor.ref} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FileDiff({ id, path }: { id: string; path: string }) {
  const load = useCallback(
    () =>
      api<{ before: string | null; now: string | null }>(
        `/records/${encodeURIComponent(id)}/diff?path=${encodeURIComponent(path)}`,
      ),
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
            className={`px-3 ${line.kind === "new" ? "bg-[#e6f2ea] text-edit" : line.kind === "gone" ? "bg-problem-soft text-problem" : ""}`}
          >
            {line.kind === "new" ? "+ " : line.kind === "gone" ? "- " : "  "}
            {line.text}
          </div>
        ),
      )}
    </pre>
  );
}

function Linked({
  title,
  items,
  open,
}: {
  title: string;
  items: { id: string; title: string; type: string }[];
  open: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="mb-6">
      <h2 className="mb-1.5 font-semibold">{title}</h2>
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
    </section>
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
    <section className="mb-6">
      <button type="button" className="cursor-pointer font-semibold hover:underline" onClick={() => setShown(!shown)}>
        History {shown ? "▾" : "▸"}
      </button>
      {shown && <Notice message={error} />}
      {shown && data?.length === 0 && <p className="mt-1.5 text-muted">No earlier version.</p>}
      {shown && data && data.length > 0 && (
        <ol className="mt-1.5 rounded-xl border border-line bg-panel">
          {[...data].reverse().map((entry) => (
            <li
              key={entry.version}
              className="flex items-center justify-between gap-3 border-t border-line px-4 py-2 first:border-t-0"
            >
              <span>
                Version {entry.version}, by {entry.author}
                {entry.device ? ` on ${entry.device}` : ""}, {moment(entry.ts)}
                {entry.snapshot.title ? ` — ${entry.snapshot.title}` : ""}
              </span>
              <Button
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
    </section>
  );
}

/** Who else has the record open, told every few seconds by the team store. */
function Presence({ id }: { id: string }) {
  const [others, setOthers] = useState<{ member: string; device: string }[]>([]);
  useEffect(() => {
    let current = true;
    const tell = () => {
      if (document.hidden) return;
      api<{ others: { member: string; device: string }[] }>(`/team/records/${encodeURIComponent(id)}/open`, {
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
    <p className="mb-4 rounded-lg border border-line bg-accent-soft px-3.5 py-2" role="status">
      Also open: {others.map((other) => `${other.member} on ${other.device}`).join(", ")}. The second save is asked to
      choose.
    </p>
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
    <section className="mb-5 rounded-xl border border-accent bg-accent-soft px-4 py-3">
      <p>{String(record.fields.reason ?? "")}</p>
      <pre className="mt-2 overflow-x-auto font-mono text-xs">{JSON.stringify(change, null, 2)}</pre>
      <Notice message={action.message} />
      <div className="mt-2.5 flex gap-2">
        <Button disabled={action.busy !== null} onClick={() => decide(true)}>
          Accept
        </Button>
        <Button quiet disabled={action.busy !== null} onClick={() => decide(false)}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
