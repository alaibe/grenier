import { api, type ReviewEntry } from "../api.ts";
import { Empty, Problem, Section, useAction, useLoad } from "../ui.tsx";

const load = () => api<{ pending: ReviewEntry[] }>("/review");

export function Review() {
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);

  return (
    <Section title="Memories to review">
      <Problem message={error ?? action.error} />
      {data && data.pending.length === 0 && <Empty>Nothing to review. AI tools propose memories with remember.</Empty>}
      {data?.pending.map((entry) => (
        <article className="memory" key={entry.id}>
          <header>
            <span>
              From <b>{entry.client}</b>, {new Date(entry.ts).toLocaleString()}
            </span>
            {entry.tags.length > 0 && <span className="tags">{entry.tags.join(", ")}</span>}
          </header>
          <pre className="diff">
            {entry.text
              .split("\n")
              .map((line) => `+ ${line}`)
              .join("\n")}
          </pre>
          <div className="actions">
            <button
              type="button"
              disabled={action.busy}
              onClick={() => void action.run(() => api(`/review/${entry.id}/approve`, { method: "POST" }))}
            >
              Approve
            </button>
            <button
              type="button"
              className="quiet"
              disabled={action.busy}
              onClick={() => void action.run(() => api(`/review/${entry.id}/reject`, { method: "POST" }))}
            >
              Reject
            </button>
          </div>
        </article>
      ))}
    </Section>
  );
}
