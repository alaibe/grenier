import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  type FieldDef,
  type HistoryEntry,
  type Link,
  type Member,
  type Overview,
  type RecordFull,
  type RecordRow,
  type TypeDef,
} from "../api.ts";
import { hunks, lineDiff } from "../diff.ts";
import { Markdown } from "../markdown.tsx";
import {
  ago,
  Button,
  ConfirmButton,
  Field,
  Input,
  Loading,
  type Message,
  moment,
  Notice,
  Select,
  useAction,
  useLoad,
} from "../ui.tsx";
import { loadSpaces, loadTypes } from "./Store.tsx";

interface Draft {
  space: string;
  title: string;
  body: string;
  fields: Record<string, unknown>;
  links: Link[];
}

/** What `/` offers to create from a body: types whose required fields all have a default. */
const QUICK = ["Task", "Meeting", "Doc", "Project", "Person"] as const;

const today = () => new Date().toISOString().slice(0, 10);

/** The required fields of a new record, filled with what they start as. */
function defaults(type: TypeDef, me: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of type.fields) {
    if (!field.required) continue;
    if (field.kind === "select") fields[field.name] = field.options?.[0];
    if (field.kind === "date") fields[field.name] = today();
    if (field.kind === "person") fields[field.name] = me;
    if (field.kind === "list") fields[field.name] = [];
  }
  return fields;
}

const loadMe = () => api<Overview>("/overview").then((overview) => overview.me ?? "");

const loadMembers = () =>
  api<{ members: Member[] }>("/team/members")
    .then((answer) => answer.members.map((member) => member.name))
    .catch(() => [] as string[]);

/** One record in a form made from its type, with its body in Markdown, what it links to, and its history. */
export function RecordEditor({ id, open, back }: { id: string; open: (id: string) => void; back: () => void }) {
  const isNew = id.startsWith("new:");
  const load = useCallback(
    () => (isNew ? Promise.resolve(null) : api<RecordFull>(`/records/${encodeURIComponent(id)}`)),
    [id, isNew],
  );
  const record = useLoad(load);
  const types = useLoad(loadTypes);
  const spaces = useLoad(loadSpaces);
  const members = useLoad(loadMembers);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState(0);
  const [conflict, setConflict] = useState<RecordFull | null>(null);
  const action = useAction(() => {});
  const [, newType, templateId] = isNew ? id.split(":") : [];
  const typeName = isNew ? newType : record.data?.type;
  const loadTemplate = useCallback(
    () => (templateId ? api<RecordFull>(`/records/${encodeURIComponent(templateId)}`) : Promise.resolve(null)),
    [templateId],
  );
  const template = useLoad(loadTemplate);
  const type = types.data?.find((entry) => entry.name === typeName);
  const who = useLoad(loadMe);
  const me = who.data ?? "";

  useEffect(() => {
    if (draft) return;
    if (record.data) {
      const { space, title, body, fields, links, version } = record.data;
      setDraft({ space, title, body, fields, links });
      setBase(version);
    } else if (isNew && type && who.data !== null && (!templateId || template.data)) {
      setDraft({
        space: template.data?.space ?? "team",
        title: "",
        body: template.data?.body ?? "",
        fields: { ...defaults(type, me), ...(template.data?.fields ?? {}) },
        links: [],
      });
    }
  }, [draft, record.data, isNew, type, me, who.data, templateId, template.data]);

  const save = (version = base) =>
    void action.run("save", async (): Promise<Message> => {
      if (!draft || !typeName) return { text: "Nothing to save." };
      const payload = { ...draft, type: typeName, ...(typeName === "Memory" ? { kind: draft.fields.kind } : {}) };
      try {
        if (isNew) {
          const created = await api<{ id: string; waiting?: boolean }>("/records", { body: payload });
          open(created.id);
          return { text: "Saved." };
        }
        const saved = await api<{ waiting?: boolean }>(`/records/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: { ...payload, baseVersion: version },
        });
        setConflict(null);
        record.reload();
        setDraft(null);
        return { text: saved.waiting ? "Saved here; it goes to the team at the next sync." : "Saved and shared." };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.body && typeof error.body === "object") {
          const current = (error.body as { conflict?: RecordFull }).conflict;
          if (current) {
            setConflict(current);
            return { text: "Someone changed this record since you opened it.", problem: true };
          }
        }
        throw error;
      }
    });

  const take = (theirs: RecordFull) => {
    setDraft({
      space: theirs.space,
      title: theirs.title,
      body: theirs.body,
      fields: theirs.fields,
      links: theirs.links,
    });
    setBase(theirs.version);
    setConflict(null);
  };

  if (record.error || types.error) return <Notice message={record.error ?? types.error} />;
  if (!draft || !type) return <Loading what="the record" />;
  const set = (change: Partial<Draft>) => setDraft({ ...draft, ...change });
  const writable = (spaces.data ?? []).filter((space) => space.kind !== "repo" || space.id === draft.space);

  return (
    <article>
      <header className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <button type="button" className="mb-2 cursor-pointer text-sm text-muted hover:underline" onClick={back}>
            ← Store
          </button>
          <input
            className="w-full bg-transparent font-serif text-4xl leading-[1.2] font-semibold outline-none placeholder:text-muted"
            aria-label="Title"
            placeholder={`New ${type.name}`}
            value={draft.title}
            onChange={(event) => set({ title: event.currentTarget.value })}
          />
          <p className="mt-1.5 text-sm text-muted">
            {type.name}
            {record.data &&
              ` · by ${record.data.author} on ${record.data.device} · changed ${ago(record.data.updatedAt)} · version ${record.data.version}`}
            {record.data && record.data.hits > 0 && ` · used ${record.data.hits} times`}
          </p>
        </div>
        <div className="flex items-center gap-2 pt-7">
          {record.data && !record.data.retiredAt && (
            <ConfirmButton
              label="Retire"
              question="Retire it for the whole team?"
              disabled={action.busy !== null}
              onConfirm={() =>
                void action.run("retire", async () => {
                  await api(`/records/${encodeURIComponent(id)}`, { method: "DELETE" });
                  back();
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
      {!isNew && <Presence id={id} />}
      {conflict && (
        <section className="mb-5 rounded-xl border border-problem bg-problem-soft px-4 py-3" aria-label="Their version">
          <p className="font-medium">
            {conflict.author} saved version {conflict.version} while you were editing.
          </p>
          <p className="mt-1 text-sm">
            Theirs: <b className="font-semibold">{conflict.title}</b>
            {conflict.body !== draft.body && " — the body differs"}
            {JSON.stringify(conflict.fields) !== JSON.stringify(draft.fields) && " — the fields differ"}
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
      {type.name === "Suggestion" && record.data && <SuggestionActions record={record.data} back={back} />}

      <div className="mb-5 grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field>
          Space
          <Select value={draft.space} onChange={(event) => set({ space: event.currentTarget.value })}>
            {writable.map((space) => (
              <option key={space.id} value={space.id}>
                {space.kind === "me" ? "me (only you)" : space.name}
              </option>
            ))}
          </Select>
        </Field>
        {type.fields.map((field) => (
          <FieldInput
            key={field.name}
            field={field}
            value={draft.fields[field.name]}
            members={members.data ?? []}
            onChange={(value) => set({ fields: { ...draft.fields, [field.name]: value } })}
          />
        ))}
      </div>

      {type.body && (
        <Body
          text={draft.body}
          onChange={(body, link) =>
            set({ body, ...(link ? { links: [...draft.links.filter((entry) => entry.ref !== link.ref), link] } : {}) })
          }
          open={open}
          space={draft.space}
          me={me}
          types={types.data ?? []}
        />
      )}

      {record.data && (
        <>
          <Anchors record={record.data} />
          <Linked title="Links to" items={record.data.linksTo} open={open} />
          <Linked title="Linked from" items={record.data.linkedFrom} open={open} />
          <History id={id} restore={(snapshot) => set(snapshot)} />
        </>
      )}
    </article>
  );
}

function FieldInput({
  field,
  value,
  members,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  members: string[];
  onChange: (value: unknown) => void;
}) {
  const label = `${field.name}${field.required ? "" : " (optional)"}`;
  const [json, setJson] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [bad, setBad] = useState(false);
  const loadOptions = useCallback(
    () =>
      field.kind === "record" && field.type
        ? api<{ records: RecordRow[] }>(`/records?type=${encodeURIComponent(field.type)}`).then((a) => a.records)
        : Promise.resolve([] as RecordRow[]),
    [field.kind, field.type],
  );
  const options = useLoad(loadOptions);

  if (field.kind === "select") {
    return (
      <Field>
        {label}
        <Select value={String(value ?? "")} onChange={(event) => onChange(event.currentTarget.value || undefined)}>
          {!field.required && <option value="">–</option>}
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (field.kind === "record") {
    return (
      <Field>
        {label}
        <Select value={String(value ?? "")} onChange={(event) => onChange(event.currentTarget.value || undefined)}>
          <option value="">–</option>
          {options.data?.map((option) => (
            <option key={option.id} value={option.id}>
              {option.title}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (field.kind === "json") {
    return (
      <div className="col-span-full">
        <Field>
          {label}
          <textarea
            className={`min-h-24 rounded-md border bg-panel px-2.5 py-2 font-mono text-sm ${bad ? "border-problem" : "border-line-strong"}`}
            value={json}
            spellCheck={false}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setJson(text);
              try {
                onChange(text.trim() === "" ? undefined : JSON.parse(text));
                setBad(false);
              } catch {
                setBad(true);
              }
            }}
          />
        </Field>
        {bad && <p className="mt-1 text-sm text-problem">Not valid JSON yet: the last valid value is kept.</p>}
      </div>
    );
  }
  if (field.kind === "list") {
    return (
      <Field>
        {label}
        <Input
          placeholder="Comma-separated"
          value={Array.isArray(value) ? value.join(", ") : ""}
          onChange={(event) =>
            onChange(
              event.currentTarget.value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            )
          }
        />
      </Field>
    );
  }
  return (
    <Field>
      {label}
      <Input
        type={field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text"}
        list={field.kind === "person" ? "grenier-members" : undefined}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(event) => {
          const text = event.currentTarget.value;
          onChange(field.kind === "number" ? (text === "" ? undefined : Number(text)) : text || undefined);
        }}
      />
      {field.kind === "person" && (
        <datalist id="grenier-members">
          {members.map((member) => (
            <option key={member} value={member} />
          ))}
        </datalist>
      )}
    </Field>
  );
}

interface Pick {
  kind: "mention" | "create";
  word: string;
  start: number;
}

/** The body: Markdown, with @ to link a record and / at the start of a line to create one and link it. */
function Body({
  text,
  onChange,
  open,
  space,
  me,
  types,
}: {
  text: string;
  onChange: (body: string, link?: Link) => void;
  open: (id: string) => void;
  space: string;
  me: string;
  types: TypeDef[];
}) {
  const [preview, setPreview] = useState(() => text.trim() !== "");
  const [pick, setPick] = useState<Pick | null>(null);
  const [matches, setMatches] = useState<RecordRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (pick?.kind !== "mention" || pick.word.length < 2) {
      setMatches([]);
      return;
    }
    let current = true;
    api<{ records: RecordRow[] }>(`/records?q=${encodeURIComponent(pick.word)}`)
      .then((answer) => current && setMatches(answer.records.slice(0, 6)))
      .catch(() => current && setMatches([]));
    return () => {
      current = false;
    };
  }, [pick]);

  const look = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const mention = /(^|\s)@([^\s@][^@\n]{0,40})?$/.exec(before);
    const create = /(^|\n)\/(\w*)(?: ([^\n]*))?$/.exec(before);
    if (create) {
      setPick({
        kind: "create",
        word: create[2] ?? "",
        start: before.length - create[0].length + (create[1] ?? "").length,
      });
    } else if (mention) {
      setPick({ kind: "mention", word: mention[2] ?? "", start: before.length - (mention[2] ?? "").length - 1 });
    } else {
      setPick(null);
    }
  };

  const insert = (start: number, end: number, replacement: string, link: Link) => {
    const next = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
    onChange(next, link);
    setPick(null);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(start + replacement.length, start + replacement.length);
    });
  };

  const create = async (typeName: string, title: string, start: number, end: number) => {
    const type = types.find((entry) => entry.name === typeName);
    if (!type || !title.trim()) return;
    try {
      const made = await api<{ id: string }>("/records", {
        body: { type: typeName, title: title.trim(), space, fields: defaults(type, me) },
      });
      insert(start, end, `[${title.trim()}](record:${made.id})`, { kind: "record", ref: made.id });
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") setPick(null);
    if (event.key !== "Enter" || pick?.kind !== "create") return;
    const caret = event.currentTarget.selectionStart;
    const line = /\/(\w+) ([^\n]+)$/.exec(text.slice(0, caret));
    const typeName = QUICK.find((name) => name.toLowerCase() === line?.[1]?.toLowerCase());
    if (!line || !typeName) return;
    event.preventDefault();
    void create(typeName, line[2] as string, caret - line[0].length, caret);
  };

  return (
    <section className="mb-6">
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="font-semibold">Body</h2>
        <fieldset className="inline-flex overflow-hidden rounded-md border border-line-strong text-sm">
          <legend className="sr-only">Body view</legend>
          {(["Write", "Preview"] as const).map((name) => (
            <button
              type="button"
              key={name}
              aria-pressed={preview === (name === "Preview")}
              className={`h-7 cursor-pointer px-2.5 ${preview === (name === "Preview") ? "bg-accent text-accent-fg" : "bg-panel hover:bg-hover"}`}
              onClick={() => setPreview(name === "Preview")}
            >
              {name}
            </button>
          ))}
        </fieldset>
      </div>
      {problem && <Notice message={problem} />}
      {preview ? (
        <div className="min-h-40 rounded-xl border border-line bg-panel px-4 py-3">
          {text.trim() ? <Markdown text={text} open={open} /> : <p className="text-muted">Nothing written.</p>}
        </div>
      ) : (
        <div className="relative">
          <textarea
            ref={area}
            className="min-h-64 w-full rounded-xl border border-line-strong bg-panel px-4 py-3 font-mono text-md leading-relaxed"
            aria-label="Body, in Markdown"
            placeholder="Markdown. @ links a record; / at the start of a line creates one, as in /task Update the docs."
            value={text}
            onChange={(event) => {
              onChange(event.currentTarget.value);
              look(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onKeyDown={keyDown}
            onBlur={() => setTimeout(() => setPick(null), 150)}
          />
          {pick?.kind === "mention" && matches.length > 0 && (
            <ul className="absolute right-3 bottom-3 z-10 w-80 rounded-lg border border-line-strong bg-panel py-1 shadow-lg">
              {matches.map((match) => (
                <li key={match.id}>
                  <button
                    type="button"
                    className="w-full cursor-pointer px-3 py-1.5 text-left hover:bg-hover"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insert(pick.start, pick.start + pick.word.length + 1, `[${match.title}](record:${match.id})`, {
                        kind: "record",
                        ref: match.id,
                      });
                    }}
                  >
                    {match.title} <span className="text-sm text-muted">{match.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {pick?.kind === "create" && (
            <p className="absolute right-3 bottom-3 rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-sm shadow-lg">
              {QUICK.map((name) => `/${name.toLowerCase()}`).join("  ")} then a title and Enter
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** The files the record was written from: unchanged, or changed since, with the change. */
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
                    ...(entry.snapshot.fields ? { fields: entry.snapshot.fields } : {}),
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
