import { api, type Overview } from "../api.ts";
import { count, Empty, money, Problem, Section, useLoad } from "../ui.tsx";

const load = () => api<Overview>("/overview");

export function Dashboard() {
  const { data, error } = useLoad(load);
  if (!data) return <Problem message={error} />;

  const total = data.days.reduce(
    (sum, day) => ({
      requests: sum.requests + day.requests,
      cost: sum.cost + day.cost,
      saved: sum.saved + day.saved,
      input: sum.input + day.inputTokens + day.cacheWriteTokens + day.cacheReadTokens,
      read: sum.read + day.cacheReadTokens,
    }),
    { requests: 0, cost: 0, saved: 0, input: 0, read: 0 },
  );
  const reused = data.cache.reduce((sum, repo) => sum + repo.hits, 0);
  const tiles: [string, string][] = [
    [money(total.cost), "spent in 7 days"],
    [money(total.saved), "saved by the prompt cache"],
    [total.input ? `${Math.round((total.read / total.input) * 100)}%` : "–", "of input from the prompt cache"],
    [count(reused), "answers reused"],
    [count(data.items), `items in ${data.sources} source(s)`],
    [count(data.pendingReview), "memories to review"],
  ];

  return (
    <>
      <div className="tiles">
        {tiles.map(([value, label]) => (
          <div className="tile" key={label}>
            <b>{value}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <Section title="Last 7 days">
        {data.days.length === 0 ? (
          <Empty>No requests yet. Run an agent through Grenier: grenier run -- claude</Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="n">Requests</th>
                  <th className="n">Input</th>
                  <th className="n">Cache read</th>
                  <th className="n">Output</th>
                  <th className="n">Cost</th>
                  <th className="n">Saved</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((day) => (
                  <tr key={day.key}>
                    <td>{day.key}</td>
                    <td className="n">{count(day.requests)}</td>
                    <td className="n">{count(day.inputTokens + day.cacheWriteTokens)}</td>
                    <td className="n">{count(day.cacheReadTokens)}</td>
                    <td className="n">{count(day.outputTokens)}</td>
                    <td className="n">{money(day.cost)}</td>
                    <td className="n">{money(day.saved)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
