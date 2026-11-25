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
import { Check, ChevronDown, ChevronUp, FileText, Undo2 } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../api.ts";
import { hunks, lineDiff } from "../diff.ts";
import { ago, exact } from "../format.ts";
import { Markdown } from "../markdown.tsx";
import { type Command, useCommands } from "../shell/commands.tsx";
import { useItemTitle } from "../shell/regions.tsx";
import { Button, Primary } from "../ui/button.tsx";
import { ConfirmButton } from "../ui/dialog.tsx";
import { Skeleton } from "../ui/empty.tsx";
import { Field, Select, Textarea } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Notice, Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { RowActions, Table } from "../ui/table.tsx";
import { Status, Tag } from "../ui/tag.tsx";
import { Tree } from "../ui/tree.tsx";

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

const pathKey = (path: { top: string; folder: string }) => `${path.top}\u0000${path.folder}`;

/** A folder path as the editor shows it, "Team / Decisions / 2026": a top folder's name, then the folders in it. */
export function folderPath(tops: Top[], top: string, folder: string): string {
  const named = tops.find((entry) => entry.id === top);
  return [named ? topName(named) : top, ...(folder ? folder.split("/") : [])].join(" / ");
}

/** A record at reading width: its folder, title and text, then where it was written from, its links and history. */
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
  const action = useAction();
  useItemTitle(record.data?.title ?? (id ? null : "New page"));

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

  const kindOf = (top: string) => tops.find((entry) => entry.id === top)?.kind;
  // A member writes in Me, and their agents' answers where they are; the team store refuses the rest.
  const from = record.data?.top ?? draft?.top ?? "";
  const answer = record.data?.type === "Memory" && kindOf(from) === "repo";
  const writes = (top: string) => !member || kindOf(top) === "me" || (answer && top === from);
  const editable = writes(from);

  const save = (version = base) =>
    void action.run(
      "save",
      async () => {
        if (!draft) return undefined;
        try {
          if (!id) {
            const created = await api<Created>("/records", { body: { ...draft, type: "Doc" } });
            changed();
            open(created.id);
            return "Saved the page";
          }
          const saved = await api<Saved>(`/records/${encodeURIComponent(id)}`, {
            method: "PUT",
            body: { ...draft, baseVersion: version },
          });
          setConflict(null);
          record.reload();
          setDraft(null);
          changed();
          if (!saved.waiting) return "Saved and shared";
          return saved.team ? "Saved here: it goes to the team at the next sync" : "Saved on this machine";
        } catch (error) {
          if (error instanceof ApiError && error.status === 409 && error.body && typeof error.body === "object") {
            const current = (error.body as Partial<Conflict>).conflict;
            if (current) {
              setConflict(current);
              return undefined;
            }
          }
          throw error;
        }
      },
      "Saving",
    );

  // biome-ignore lint/correctness/useExhaustiveDependencies: save reads the draft as it is when it runs
  const commands = useMemo<Command[]>(
    () =>
      editable
        ? [
            {
              id: "page.save",
              label: "Save the page",
              keys: "mod+enter",
              also: ["mod+s"],
              hint: { in: "item", says: "save", order: 10 },
              run: () => save(conflict?.version ?? base),
            },
          ]
        : [],
    [editable, conflict, base, draft],
  );
  useCommands(commands);

  if (record.error)
    return (
      <div className="p-6">
        <Problem error={record.error} />
      </div>
    );
  if (!draft) {
    return (
      <div className="mx-auto w-full max-w-(--layout-reading) px-6 pt-6">
        <Skeleton rows={6} shape="text" />
      </div>
    );
  }
  const set = (change: Partial<Draft>) => setDraft({ ...draft, ...change });
  const here = { top: draft.top, folder: draft.folder };
  const allowed = folderPaths.filter((path) => writes(path.top));
  const choices = allowed.some((path) => pathKey(path) === pathKey(here))
    ? allowed
    : [...allowed, { ...here, label: folderPath(tops, draft.top, draft.folder) }];
  const kind =
    record.data && record.data.type !== "Doc" ? [record.data.type, record.data.kind].filter(Boolean).join(" · ") : null;

  return (
    <article className="mx-auto w-full max-w-(--layout-reading) px-6 pt-6 pb-12" data-verb="save">
      <header className="mb-4 flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field label="Folder">
            <Select
              disabled={!editable}
              value={pathKey(here)}
              onChange={(event) => {
                const path = choices.find((entry) => pathKey(entry) === event.currentTarget.value);
                if (path) set({ top: path.top, folder: path.folder });
              }}
            >
              {choices.map((path) => (
                <option key={pathKey(path)} value={pathKey(path)}>
                  {path.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {editable && (
          <div className="flex shrink-0 items-center gap-2">
            {record.data && !record.data.retiredAt && (
              <ConfirmButton
                label="Retire"
                disabled={action.busy !== null}
                title={`Retire “${record.data.title}”?`}
                body={
                  draft.top === "me"
                    ? "It leaves your pages and your agents stop reading it. Its history stays."
                    : "It leaves the pages of everyone who reads this folder, and their agents stop reading it. Its history stays."
                }
                action="Retire the page"
                run={() =>
                  void action.run("retire", async () => {
                    await api(`/records/${encodeURIComponent(record.data?.id ?? "")}`, { method: "DELETE" });
                    changed();
                    closed();
                    return "Retired the page";
                  })
                }
              />
            )}
            <Primary keys="mod+enter" busy={action.busy === "save"} onClick={() => save(conflict?.version ?? base)}>
              {conflict ? "Keep mine" : "Save"}
            </Primary>
          </div>
        )}
      </header>
      <input
        className="w-full bg-transparent font-mono text-xl leading-tight font-semibold tracking-tight outline-none placeholder:text-muted"
        aria-label="Title"
        placeholder="Untitled"
        readOnly={!editable}
        value={draft.title}
        onChange={(event) => set({ title: event.currentTarget.value })}
      />
      {record.data && (
        <p className="mt-1 font-mono text-xs text-muted tabular-nums">
          {kind && `${kind} · `}by {record.data.author} on {record.data.device} ·{" "}
          <time title={exact(record.data.updatedAt)}>changed {ago(record.data.updatedAt)}</time>
          {record.data.hits > 0 && ` · used ${record.data.hits} times`}
        </p>
      )}

      <div className="mt-4 grid gap-2">
        <Problem error={action.problem} />
        {conflict && (
          <Notice
            kind="warn"
            more={`Theirs is titled “${conflict.title}”${conflict.body !== draft.body ? ", and its text differs" : ""}. Keep mine saves over it.`}
            action={
              <Button size="sm" onClick={() => take(conflict)}>
                Take theirs
              </Button>
            }
          >
            {conflict.author} saved version {conflict.version} while you were editing.
          </Notice>
        )}
        {record.data?.retiredAt && <Notice kind="info">Retired {ago(record.data.retiredAt)}.</Notice>}
        {!editable && <Notice kind="info">Only an admin changes the pages here.</Notice>}
        {id && <Presence id={id} />}
        {record.data?.type === "Suggestion" && <Suggestion record={record.data} back={closed} />}
      </div>

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

  function take(theirs: TeamRecord) {
    setDraft({ top: theirs.top, folder: theirs.folder, title: theirs.title, body: theirs.body, links: theirs.links });
    setBase(theirs.version);
    setConflict(null);
  }
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
  const [writing, setWriting] = useState(() => editable && text.trim() === "");
  const preview = !editable || !writing;
  const [mention, setMention] = useState<{ word: string; start: number } | null>(null);
  const [matches, setMatches] = useState<RecordRow[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!mention || mention.word.length < 2) {
      setMatches([]);
      return;
    }
    let current = true;
    api<{ records: RecordRow[] }>(`/records?q=${encodeURIComponent(mention.word)}`)
      .then((answer) => {
        if (!current) return;
        setMatches(answer.records.slice(0, 6));
        setHighlighted(0);
      })
      .catch(() => current && setMatches([]));
    return () => {
      current = false;
    };
  }, [mention]);

  const look = (value: string, caret: number) => {
    const found = /(^|\s)@([^\s@][^@\n]{0,40})?$/.exec(value.slice(0, caret));
    setMention(found ? { word: found[2] ?? "", start: caret - (found[2] ?? "").length - 1 } : null);
  };

  const insert = (match: RecordRow) => {
    if (!mention) return;
    const start = mention.start;
    const replacement = `[${match.title}](record:${match.id})`;
    onChange(`${text.slice(0, start)}${replacement}${text.slice(start + mention.word.length + 1)}`, {
      kind: "record",
      ref: match.id,
    });
    setMention(null);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(start + replacement.length, start + replacement.length);
    });
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mention || matches.length === 0) return;
    if (event.key === "ArrowDown") setHighlighted((index) => (index + 1) % matches.length);
    else if (event.key === "ArrowUp") setHighlighted((index) => (index - 1 + matches.length) % matches.length);
    else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      const match = matches[highlighted];
      if (match) insert(match);
    } else if (event.key === "Escape") setMention(null);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <section className="mt-6">
      {editable && (
        <div className="mb-3 flex justify-end">
          <Segmented
            label="Text view"
            options={[
              ["write", "Write"],
              ["preview", "Preview"],
            ]}
            value={preview ? "preview" : "write"}
            onChange={(view) => setWriting(view === "write")}
          />
        </div>
      )}
      {preview && !text.trim() && <p className="text-muted">Nothing written yet.</p>}
      {preview && text.trim() && <Markdown text={text} open={open} />}
      {!preview && (
        <div className="relative">
          <Textarea
            ref={area}
            rows={18}
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
            <div
              className="menu absolute right-3 bottom-3 w-80"
              style={{ zIndex: "var(--layer-popover)" }}
              role="listbox"
              aria-label="Pages to link"
            >
              {matches.map((match, index) => (
                <div
                  key={match.id}
                  className="menu-item"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === highlighted}
                  data-highlighted={index === highlighted || undefined}
                  onPointerMove={() => setHighlighted(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insert(match);
                  }}
                  onKeyDown={() => {}}
                >
                  <FileText className="icon" aria-hidden="true" />
                  <span className="truncate">{match.title}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The files the page was written from, and whether each changed since. */
function Anchors({ record }: { record: RecordFull }) {
  const files = record.anchors.filter((anchor) => anchor.kind === "git");
  const [shown, setShown] = useState<string | null>(null);
  if (files.length === 0) return null;
  return (
    <Section title="Written from">
      <Table
        label="Files the page was written from"
        head={
          <>
            <th>File</th>
            <th>State</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </>
        }
      >
        {files.map((anchor) => {
          const differs = record.changed.includes(anchor.ref);
          return [
            <tr key={anchor.ref}>
              <td className="mono">{anchor.ref}</td>
              <td>
                {differs ? (
                  <Status kind="warn" word="changed" />
                ) : record.status === "unchecked" ? (
                  <Status kind="draft" word="not here" />
                ) : (
                  <Status kind="ok" word="unchanged" />
                )}
              </td>
              <td className="num">
                {differs && (
                  <Button
                    variant="ghost"
                    size="sm"
                    trailing={shown === anchor.ref ? ChevronUp : ChevronDown}
                    aria-expanded={shown === anchor.ref}
                    onClick={() => setShown(shown === anchor.ref ? null : anchor.ref)}
                  >
                    {shown === anchor.ref ? "Hide the change" : "Show the change"}
                  </Button>
                )}
              </td>
            </tr>,
            shown === anchor.ref && (
              <tr key={`${anchor.ref}:diff`}>
                <td colSpan={3} className="py-2 whitespace-normal">
                  <FileDiff id={record.id} path={anchor.ref} />
                </td>
              </tr>
            ),
          ];
        })}
      </Table>
    </Section>
  );
}

function FileDiff({ id, path }: { id: string; path: string }) {
  const load = useCallback(
    () => api<FileVersions>(`/records/${encodeURIComponent(id)}/diff?path=${encodeURIComponent(path)}`),
    [id, path],
  );
  const { data, error } = useLoad(load);
  if (error) return <Problem error={error} />;
  if (!data) return <Skeleton rows={3} shape="text" />;
  if (data.now === null) return <p className="text-sm text-muted">The file is gone.</p>;
  if (data.before === null) return <p className="text-sm text-muted">The version it was written from is not here.</p>;
  const lines = lineDiff(data.before, data.now);
  if (!lines) return <p className="text-sm text-muted">Too large a change to show here.</p>;
  return (
    <pre className="diff">
      {hunks(lines).map((line, n) =>
        line === null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a diff have no other identity
          <div key={n} className="text-muted">
            ⋯
          </div>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a diff have no other identity
          <div key={n} className={line.kind === "new" ? "diff-new" : line.kind === "gone" ? "diff-gone" : ""}>
            {line.kind === "new" ? "+ " : line.kind === "gone" ? "− " : "  "}
            {line.text}
          </div>
        ),
      )}
    </pre>
  );
}

function Linked({ title, items, open }: { title: string; items: LinkedRecord[]; open: (id: string) => void }) {
  const [cursor, setCursor] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <Section title={title}>
      <div className="border-y border-line">
        <Tree
          label={title}
          nodes={items.map((item) => ({ id: item.id, name: item.title, icon: FileText, meta: <Tag>{item.type}</Tag> }))}
          selected={cursor}
          open={() => false}
          onSelect={(node) => setCursor(node.id)}
          onToggle={() => {}}
          onOpen={(node) => open(node.id)}
        />
      </div>
    </Section>
  );
}

function History({ id, restore }: { id: string; restore: (draft: Partial<Draft>) => void }) {
  const load = useCallback(
    () => api<{ history: HistoryEntry[] }>(`/records/${encodeURIComponent(id)}/history`).then((a) => a.history),
    [id],
  );
  return (
    <Section
      title="History"
      collapsible="page.history"
      description="Restore puts a version in the editor; Save makes it the latest."
    >
      <Versions load={load} restore={restore} />
    </Section>
  );
}

function Versions({
  load,
  restore,
}: {
  load: () => Promise<HistoryEntry[]>;
  restore: (draft: Partial<Draft>) => void;
}) {
  const { data, error } = useLoad(load);
  if (error) return <Problem error={error} />;
  if (!data) return <Skeleton rows={3} shape="table" />;
  if (data.length === 0) return <p className="text-muted">No earlier version.</p>;
  return (
    <Table
      label="Versions"
      head={
        <>
          <th className="num">Version</th>
          <th>By</th>
          <th>Saved</th>
          <th>
            <span className="sr-only">Actions</span>
          </th>
        </>
      }
    >
      {[...data].reverse().map((entry) => (
        <tr key={entry.version}>
          <td className="num mono">{entry.version}</td>
          <td>
            {entry.author}
            {entry.device ? ` on ${entry.device}` : ""}
          </td>
          <td className="mono">{exact(entry.ts)}</td>
          <RowActions>
            <Button
              variant="ghost"
              size="sm"
              icon={Undo2}
              onClick={() =>
                restore({
                  ...(typeof entry.snapshot.title === "string" ? { title: entry.snapshot.title } : {}),
                  ...(typeof entry.snapshot.body === "string" ? { body: entry.snapshot.body } : {}),
                })
              }
            >
              Restore
            </Button>
          </RowActions>
        </tr>
      ))}
    </Table>
  );
}

/** Who else has the record open, told every few seconds by the team store: a state that lasts, so a notice. */
function Presence({ id }: { id: string }) {
  const [others, setOthers] = useState<Editors["others"]>([]);
  useEffect(() => {
    let current = true;
    const tell = () => {
      if (document.hidden) return;
      api<Editors>(`/team/records/${encodeURIComponent(id)}/open`, { method: "PUT", body: {} })
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
    <Notice kind="info" more="The second save is asked to choose.">
      Also open: {others.map((other) => `${other.member} on ${other.device}`).join(", ")}.
    </Notice>
  );
}

/** A suggestion of the librarian: accepted, its change goes into the record it names; either way it is retired. */
function Suggestion({ record, back }: { record: RecordFull; back: () => void }) {
  const action = useAction();
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
      return accept ? "Accepted the suggestion" : "Dismissed the suggestion";
    });
  return (
    <>
      <Notice
        kind="accent"
        tag="SUGGESTION"
        action={
          <Button
            size="sm"
            icon={Check}
            busy={action.busy === "accept"}
            disabled={action.busy !== null}
            onClick={() => decide(true)}
          >
            Accept
          </Button>
        }
        onDismiss={() => decide(false)}
      >
        {String(record.fields.reason ?? "The librarian suggests a change.")}
      </Notice>
      <pre className="diff">
        <div>{JSON.stringify(change, null, 2)}</div>
      </pre>
      <Problem error={action.problem} />
    </>
  );
}
