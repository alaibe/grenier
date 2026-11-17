import type { ViewProps } from "../App.tsx";
import { api, type Overview } from "../api.ts";
import { compact, count, day, Empty, Loading, money, Notice, Page, useLoad } from "../ui.tsx";

const load = () => api<Overview>("/overview");

export function Dashboard({ go }: ViewProps) {
  const { data, error } = useLoad(load);

  const total = (data?.days ?? []).reduce(
    (sum, row) => ({
      cost: sum.cost + row.cost,
      saved: sum.saved + row.saved,
      input: sum.input + row.inputTokens + row.cacheWriteTokens + row.cacheReadTokens,
      read: sum.read + row.cacheReadTokens,
    }),
    { cost: 0, saved: 0, input: 0, read: 0 },
  );
  const reused = (data?.cache ?? []).reduce((sum, repo) => sum + repo.hits, 0);
  const figures: [string, string][] = [
    [money(total.cost), "spent"],
    [money(total.saved), "saved by the prompt cache"],
    [total.input ? `${Math.round((total.read / total.input) * 100)}%` : "–", "of input read from the cache"],
    [count(reused), "answers reused"],
  ];

  return (
    <Page title="Dashboard" intro="What your agents spent through Grenier in the last 7 days.">
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
      {data && (data.days.length > 0 || reused > 0) && (
        <dl className="figures">
          {figures.map(([value, label]) => (
            <div key={label}>
              <dd>{value}</dd>
              <dt>{label}</dt>
            </div>
          ))}
        </dl>
      )}
      {data && data.days.length === 0 && (
        <Empty>
          <p>No requests yet. Run an agent through Grenier and its usage shows here:</p>
          <code>grenier run -- claude</code>
        </Empty>
      )}
      {data && data.days.length > 0 && (
        <section>
          <h2>Per day</h2>
          <div className="table">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="n">Requests</th>
                  <th className="n">Input</th>
                  <th className="n">From cache</th>
                  <th className="n">Output</th>
                  <th className="n">Cost</th>
                  <th className="n">Saved</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((row) => (
                  <tr key={row.key}>
                    <td>{day(row.key)}</td>
                    <td className="n">{count(row.requests)}</td>
                    <td className="n" title={count(row.inputTokens + row.cacheWriteTokens)}>
                      {compact(row.inputTokens + row.cacheWriteTokens)}
                    </td>
                    <td className="n" title={count(row.cacheReadTokens)}>
                      {compact(row.cacheReadTokens)}
                    </td>
                    <td className="n" title={count(row.outputTokens)}>
                      {compact(row.outputTokens)}
                    </td>
                    <td className="n">{money(row.cost)}</td>
                    <td className="n">{money(row.saved)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">Input, from cache and output are tokens. Hover a number for the exact count.</p>
        </section>
      )}
    </Page>
  );
}
