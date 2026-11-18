import type { ViewProps } from "../App.tsx";
import { api, type ReviewEntry } from "../api.ts";
import { Button, Empty, Loading, moment, Notice, Page, useAction, useLoad } from "../ui.tsx";

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
        <article className="mb-6 rounded-xl border border-line bg-panel px-5 py-4.5" key={entry.id}>
          <header className="flex justify-between gap-3 text-md text-muted">
            <span>
              From <b className="font-semibold text-fg">{entry.client}</b>, {moment(entry.ts)}
            </span>
            {entry.tags.length > 0 && (
              <span className="inline-flex flex-wrap gap-1">
                {entry.tags.map((tag) => (
                  <span className="rounded-[5px] border border-line-strong px-1.75 text-xs leading-5" key={tag}>
                    {tag}
                  </span>
                ))}
              </span>
            )}
          </header>
          <p className="mt-2.5 mb-4 text-lg whitespace-pre-wrap">{entry.text}</p>
          <div className="flex items-center gap-2">
            <Button disabled={action.busy !== null} onClick={() => decide(entry, "approve")}>
              Approve
            </Button>
            <Button quiet disabled={action.busy !== null} onClick={() => decide(entry, "reject")}>
              Reject
            </Button>
          </div>
        </article>
      ))}
    </Page>
  );
}
