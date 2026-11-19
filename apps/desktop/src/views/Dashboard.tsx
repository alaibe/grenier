import { useEffect } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type Overview, type PausedSession } from "../api.ts";
import {
  ago,
  Button,
  day,
  Empty,
  Figure,
  Figures,
  Loading,
  money,
  Notice,
  Page,
  Table,
  useAction,
  useLoad,
} from "../ui.tsx";

const load = () => api<Overview>("/overview");
const loadPaused = () => api<{ sessions: PausedSession[] }>("/sessions/paused");
const REFRESH_MS = 30_000;

export function Dashboard({ go }: ViewProps) {
  const { data, error, reload } = useLoad(load);
  useEffect(() => {
    const timer = window.setInterval(reload, REFRESH_MS);
    window.addEventListener("focus", reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reload);
    };
  }, [reload]);

  const days = data?.days ?? [];
  const cost = days.reduce((sum, row) => sum + row.cost, 0);
  const saved = days.reduce((sum, row) => sum + row.saved, 0);

  return (
    <Page title="Dashboard" intro="Your agents' requests through Grenier in the last 7 days, priced at API rates.">
      <Notice message={error} />
      {!data && !error && <Loading what="usage" />}
      {data && data.paused > 0 && <Paused key={data.paused} changed={reload} />}
      {data && data.pendingReview > 0 && (
        <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-accent bg-accent-soft py-2.5 pr-2.5 pl-4">
          <p>{data.pendingReview === 1 ? "1 memory waits" : `${data.pendingReview} memories wait`} for your review.</p>
          <Button onClick={() => go("review")}>Review</Button>
        </div>
      )}
      {data && days.length === 0 && (
        <Empty>
          <p>No requests yet. Run an agent through Grenier and its usage shows here:</p>
          <code>grenier run -- claude</code>
        </Empty>
      )}
      {days.length > 0 && (
        <>
          <Figures className="mb-7 grid-cols-2">
            <Figure value={money(cost)} label="API cost" />
            <Figure value={money(saved)} label="saved by the prompt cache" />
          </Figures>
          <section>
            <h2 className="mb-2.5 font-semibold">Per day</h2>
            <Table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="text-right tabular-nums">API cost</th>
                  <th className="text-right tabular-nums">Saved</th>
                </tr>
              </thead>
              <tbody>
                {[...days]
                  .sort((a, b) => b.key.localeCompare(a.key))
                  .map((row) => (
                    <tr key={row.key}>
                      <td>{day(row.key)}</td>
                      <td className="text-right tabular-nums">{money(row.cost)}</td>
                      <td className="text-right tabular-nums">{money(row.saved)}</td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </section>
        </>
      )}
    </Page>
  );
}

/** The sessions the loop guard paused: their requests wait until they are resumed, or time out. */
function Paused({ changed }: { changed: () => void }) {
  const { data, error, reload } = useLoad(loadPaused);
  const action = useAction(() => {
    reload();
    changed();
  });
  if (!data || data.sessions.length === 0) return <Notice message={error} />;
  return (
    <div className="mb-5 rounded-xl border border-problem bg-problem-soft py-1 pr-2.5 pl-4">
      <Notice message={action.message?.problem ? action.message : null} />
      {data.sessions.map((session) => (
        <div className="flex items-center justify-between gap-4 py-1.5" key={session.id}>
          <p>
            Paused after a possible loop: <b className="font-semibold">{session.client ?? "an agent"}</b>
            {session.repo ? ` in ${session.repo}` : ""}
            {session.pausedAt ? `, ${ago(session.pausedAt)}` : ""}. Its requests wait until you resume it.
          </p>
          <Button
            disabled={action.busy !== null}
            onClick={() =>
              void action.run(`resume:${session.id}`, async () => {
                await api(`/sessions/${encodeURIComponent(session.id)}/resume`, { method: "POST" });
                return undefined;
              })
            }
          >
            Resume
          </Button>
        </div>
      ))}
    </div>
  );
}
