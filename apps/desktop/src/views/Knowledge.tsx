import { useCallback, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type RecordRow, type Space, type TypeDef } from "../api.ts";
import { ago, Button, Empty, Input, Loading, Notice, Page, Select, Table, useAction, useLoad } from "../ui.tsx";
import { RecordEditor } from "./Record.tsx";

export const loadTypes = () => api<{ types: TypeDef[] }>("/types").then((answer) => answer.types);
export const loadSpaces = () => api<{ spaces: Space[] }>("/spaces").then((answer) => answer.spaces);

/** A record whose title starts with "Template:" is a template for new records of its type. */
export const TEMPLATE = /^template:\s*/i;
const loadTemplates = () =>
  api<{ records: RecordRow[] }>("/records").then((answer) =>
    answer.records.filter((record) => TEMPLATE.test(record.title)),
  );

type Layout = "table" | "board" | "calendar";

const STATUSES = ["to-do", "doing", "done"] as const;

export function Knowledge({ focus }: ViewProps) {
  const [open, setOpen] = useState<string | null>(focus ?? null);
  if (open) return <RecordEditor key={open} id={open} open={setOpen} back={() => setOpen(null)} />;
  return <KnowledgeList open={setOpen} />;
}

function KnowledgeList({ open }: { open: (id: string) => void }) {
  const [words, setWords] = useState("");
  const [type, setType] = useState("");
  const [space, setSpace] = useState("");
  const [layout, setLayout] = useState<Layout>("table");
  const types = useLoad(loadTypes);
  const spaces = useLoad(loadSpaces);
  const load = useCallback(() => {
    const search = new URLSearchParams();
    if (words.trim()) search.set("q", words.trim());
    if (type) search.set("type", type);
    if (space) search.set("space", space);
    return api<{ records: RecordRow[] }>(`/records?${search}`).then((answer) => answer.records);
  }, [words, type, space]);
  const records = useLoad(load);
  const templates = useLoad(loadTemplates);
  const action = useAction(records.reload);
  const typeDef = types.data?.find((entry) => entry.name === type);
  const dateField = typeDef?.fields.find((field) => field.kind === "date")?.name;
  const layouts: Layout[] = [
    "table",
    ...(type === "Task" ? ["board" as const] : []),
    ...(dateField ? ["calendar" as const] : []),
  ];
  const shown = layouts.includes(layout) ? layout : "table";
  const spaceName = (id: string) => spaces.data?.find((entry) => entry.id === id)?.name ?? id;

  const move = (record: RecordRow, status: string) =>
    void action.run(`move:${record.id}`, async () => {
      await api(`/records/${encodeURIComponent(record.id)}`, {
        method: "PUT",
        body: { fields: { ...record.fields, status } },
      });
      return undefined;
    });

  return (
    <Page
      title="Knowledge"
      intro="What your team and its agents know: projects, tasks, meetings, decisions, docs, memories, skills and routines. Shared with the team as soon as it is written; me is yours alone. A record titled Template: … starts new ones of its type."
      action={
        <Select
          aria-label="New record"
          value=""
          onChange={(event) => {
            if (event.currentTarget.value) open(`new:${event.currentTarget.value}`);
          }}
        >
          <option value="">New…</option>
          {types.data
            ?.filter((entry) => !["Suggestion", "Skill", "McpServer"].includes(entry.name))
            .map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          {templates.data && templates.data.length > 0 && (
            <optgroup label="From a template">
              {templates.data.map((template) => (
                <option key={template.id} value={`${template.type}:${template.id}`}>
                  {template.title.replace(TEMPLATE, "")} ({template.type})
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      }
    >
      <Notice message={records.error ?? types.error ?? action.message} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="min-w-60 flex-1">
          <Input
            type="search"
            placeholder="Search"
            aria-label="Search the store"
            value={words}
            onChange={(event) => setWords(event.currentTarget.value)}
          />
        </div>
        <Select aria-label="Type" value={type} onChange={(event) => setType(event.currentTarget.value)}>
          <option value="">Every type</option>
          {types.data?.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Space" value={space} onChange={(event) => setSpace(event.currentTarget.value)}>
          <option value="">Every space</option>
          {spaces.data?.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </Select>
        {layouts.length > 1 && (
          <fieldset className="inline-flex overflow-hidden rounded-md border border-line-strong">
            <legend className="sr-only">Layout</legend>
            {layouts.map((name) => (
              <button
                type="button"
                key={name}
                aria-pressed={shown === name}
                className={`h-8 cursor-pointer px-3 capitalize ${shown === name ? "bg-accent text-accent-fg" : "bg-panel hover:bg-hover"}`}
                onClick={() => setLayout(name)}
              >
                {name}
              </button>
            ))}
          </fieldset>
        )}
      </div>
      {!records.data && !records.error && <Loading what="records" />}
      {records.data?.length === 0 && (
        <Empty>
          {words || type || space ? (
            <p>Nothing matches.</p>
          ) : (
            <>
              <p>Nothing kept yet. Agents fill it with remember; add a record with New, or install the MCP server:</p>
              <code>grenier mcp install claude-code</code>
            </>
          )}
        </Empty>
      )}
      {records.data && records.data.length > 0 && shown === "table" && (
        <Table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Space</th>
              <th>Author</th>
              <th>Changed</th>
            </tr>
          </thead>
          <tbody>
            {records.data.map((record) => (
              <tr key={record.id}>
                <td>
                  <button
                    type="button"
                    className="cursor-pointer text-left font-medium hover:underline"
                    onClick={() => open(record.id)}
                  >
                    {record.title}
                  </button>
                  {record.status === "stale" && (
                    <span className="ml-2 text-xs text-problem" title={`Changed since: ${record.changed.join(", ")}`}>
                      stale
                    </span>
                  )}
                </td>
                <td>{record.type === "Memory" ? `Memory · ${record.kind}` : record.type}</td>
                <td>{spaceName(record.space)}</td>
                <td>{record.author}</td>
                <td className="whitespace-nowrap">{ago(record.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {records.data && records.data.length > 0 && shown === "board" && (
        <div className="grid grid-cols-3 gap-3">
          {STATUSES.map((status, column) => (
            <section key={status} className="rounded-xl border border-line bg-side p-2.5">
              <h2 className="mb-2 px-1 font-semibold capitalize">{status}</h2>
              {records.data
                ?.filter((record) => (record.fields.status ?? "to-do") === status)
                .map((record) => (
                  <article key={record.id} className="mb-2 rounded-lg border border-line bg-panel px-3 py-2.5">
                    <button
                      type="button"
                      className="cursor-pointer text-left font-medium hover:underline"
                      onClick={() => open(record.id)}
                    >
                      {record.title}
                    </button>
                    <p className="mt-1 text-sm text-muted">
                      {String(record.fields.owner ?? record.author)}
                      {record.fields.routine ? " · request" : ""}
                    </p>
                    <div className="mt-2 flex gap-1.5">
                      {column > 0 && (
                        <Button
                          quiet
                          aria-label={`Move to ${STATUSES[column - 1]}`}
                          disabled={action.busy !== null}
                          onClick={() => move(record, STATUSES[column - 1] as string)}
                        >
                          ←
                        </Button>
                      )}
                      {column < STATUSES.length - 1 && (
                        <Button
                          quiet
                          aria-label={`Move to ${STATUSES[column + 1]}`}
                          disabled={action.busy !== null}
                          onClick={() => move(record, STATUSES[column + 1] as string)}
                        >
                          →
                        </Button>
                      )}
                    </div>
                  </article>
                ))}
            </section>
          ))}
        </div>
      )}
      {records.data && records.data.length > 0 && shown === "calendar" && dateField && (
        <Calendar records={records.data} field={dateField} open={open} />
      )}
    </Page>
  );
}

/** Records by the day their date field names, the latest first. */
function Calendar({ records, field, open }: { records: RecordRow[]; field: string; open: (id: string) => void }) {
  const days = new Map<string, RecordRow[]>();
  for (const record of records) {
    const key = String(record.fields[field] ?? "").slice(0, 10) || "no date";
    days.set(key, [...(days.get(key) ?? []), record]);
  }
  return (
    <div className="flex flex-col gap-3">
      {[...days.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([key, list]) => (
          <section key={key} className="grid grid-cols-[120px_1fr] gap-3 border-t border-line pt-2.5">
            <h2 className="font-semibold tabular-nums">
              {key === "no date"
                ? key
                : new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
            </h2>
            <ul>
              {list.map((record) => (
                <li key={record.id}>
                  <button type="button" className="cursor-pointer hover:underline" onClick={() => open(record.id)}>
                    {record.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
