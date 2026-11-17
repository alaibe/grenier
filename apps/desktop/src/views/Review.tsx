import type { ViewProps } from "../App.tsx";
import { api, type ReviewEntry } from "../api.ts";
import { Empty, Loading, moment, Notice, Page, useAction, useLoad } from "../ui.tsx";

const load = () => api<{ pending: ReviewEntry[] }>("/review");

export function Review({ changed }: ViewProps) {
  const { data, error, reload } = useLoad(load);
  const action = useAction(() => {
    reload();
    changed();
  });

  const decide = (entry: ReviewEntry, verdict: "approve" | "reject") =>
    void action.run(`${verdict}:${entry.id}`, async () => {
      await api(`/review/${entry.id}/${verdict}`, { method: "POST" });
      return undefined;
    });

  return (
    <Page
      title="Review queue"
      intro="Memories your AI tools proposed with remember. An approved one joins the memory source."
    >
      <Notice message={error ?? action.message} />
      {!data && !error && <Loading what="memories" />}
      {data && data.pending.length === 0 && <Empty>Nothing to review.</Empty>}
      {data?.pending.map((entry) => (
        <article className="panel memory" key={entry.id}>
          <header>
            <span>
              From <b>{entry.client}</b>, {moment(entry.ts)}
            </span>
            {entry.tags.length > 0 && (
              <span className="tags">
                {entry.tags.map((tag) => (
                  <span className="tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </span>
            )}
          </header>
          <p className="memory-text">{entry.text}</p>
          <div className="buttons">
            <button type="button" disabled={action.busy !== null} onClick={() => decide(entry, "approve")}>
              Approve
            </button>
            <button
              type="button"
              className="quiet"
              disabled={action.busy !== null}
              onClick={() => decide(entry, "reject")}
            >
              Reject
            </button>
          </div>
        </article>
      ))}
    </Page>
  );
}
