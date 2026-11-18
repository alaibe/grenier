import { useEffect } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type Overview } from "../api.ts";
import { day, Empty, Loading, money, Notice, Page, useLoad } from "../ui.tsx";

const load = () => api<Overview>("/overview");
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
      {data && data.pendingReview > 0 && (
        <div className="callout">
          <p>{data.pendingReview === 1 ? "1 memory waits" : `${data.pendingReview} memories wait`} for your review.</p>
          <button type="button" onClick={() => go("review")}>
            Review
          </button>
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
          <dl className="figures">
            <div>
              <dd>{money(cost)}</dd>
              <dt>API cost</dt>
            </div>
            <div>
              <dd>{money(saved)}</dd>
              <dt>saved by the prompt cache</dt>
            </div>
          </dl>
          <section>
            <h2>Per day</h2>
            <div className="table">
              <table>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="n">API cost</th>
                    <th className="n">Saved</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((row) => (
                    <tr key={row.key}>
                      <td>{day(row.key)}</td>
                      <td className="n">{money(row.cost)}</td>
                      <td className="n">{money(row.saved)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </Page>
  );
}
