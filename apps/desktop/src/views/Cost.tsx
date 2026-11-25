import type { Overview, PausedSession, ReportRow, SessionRow } from "@grenier/core/api";
import { Play } from "lucide-react";
import { useEffect } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { ago, count, day, exact, money, since, times } from "../format.ts";
import { Detail } from "../shell/regions.tsx";
import { Button } from "../ui/button.tsx";
import { BarChart } from "../ui/chart.tsx";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Notice, Problem } from "../ui/notice.tsx";
import { Page, Section } from "../ui/page.tsx";
import { Stat, Stats } from "../ui/stat.tsx";
import { Table } from "../ui/table.tsx";

const load = () => api<Overview>("/overview");
const loadPaused = () => api<{ sessions: PausedSession[] }>("/sessions/paused");
const REFRESH_MS = 30_000;

/** The last `n` report days, oldest first, as YYYY-MM-DD in local time. */
function lastDays(n: number): string[] {
  return Array.from({ length: n }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (n - 1 - index));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
}

const total = (rows: ReportRow[], pick: (row: ReportRow) => number) => rows.reduce((sum, row) => sum + pick(row), 0);

export function Cost({ changed }: ViewProps) {
  const { data, error, reload } = useLoad(load);
  useEffect(() => {
    // Nothing to refresh while the window is hidden; it catches up when it is shown again.
    const timer = window.setInterval(() => {
      if (!document.hidden) reload();
    }, REFRESH_MS);
    window.addEventListener("focus", reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reload);
    };
  }, [reload]);

  const days = data?.days ?? [];
  const byDay = [...days].sort((a, b) => a.key.localeCompare(b.key));
  const week = lastDays(7).map((key) => days.find((row) => row.key === key) ?? { key, cost: 0, saved: 0 });
  return (
    <Detail title="Cost">
      <Page
        title="Cost"
        intro="Your agents' requests through Grenier in the last 7 days, priced at API rates. Cached is what Anthropic's prompt cache took off."
      >
        <Problem error={error} />
        {data && data.paused > 0 && (
          <Paused
            key={data.paused}
            changed={() => {
              reload();
              changed();
            }}
          />
        )}
        {!data && !error && <Skeleton rows={6} shape="table" />}
        {data && days.length === 0 && (
          <Empty boot="no requests yet">
            Run an agent through Grenier, <code>grenier run -- claude</code>, and what it spends shows here.
          </Empty>
        )}
        {data && days.length > 0 && (
          <>
            <Stats columns={3}>
              <Stat label="API cost" value={money(total(days, (row) => row.cost))} lit change="last 7 days" />
              <Stat label="Cached" value={money(total(days, (row) => row.saved))} change="prompt-cache discount" />
              <Stat
                label="Sessions"
                value={count(data.sessions.length)}
                change={`${times(data.projects.length, "project")}`}
              />
            </Stats>
            <Section title="Per day">
              <BarChart
                label={`API cost per day, ${byDay.map((row) => `${day(row.key)} ${money(row.cost)}`).join(", ")}`}
                series={[
                  { name: "API cost", key: true },
                  { name: "Cached", key: false },
                ]}
                groups={week.map((row) => ({
                  label: day(row.key).split(" ")[0]?.toUpperCase() ?? row.key,
                  title: day(row.key),
                  values: [row.cost, row.saved],
                }))}
                format={(value) => `$${value % 1 === 0 ? value : value.toFixed(2)}`}
              />
            </Section>
            <Spending title="Per project" first="Project" rows={data.projects} name={(row) => row.key} />
            <Sessions rows={data.sessions} />
            <Spending
              title="Per day, in figures"
              first="Day"
              rows={[...byDay].reverse()}
              name={(row) => day(row.key)}
              mono
            />
          </>
        )}
      </Page>
    </Detail>
  );
}

function Spending({
  title,
  first,
  rows,
  name,
  mono = false,
}: {
  title: string;
  first: string;
  rows: ReportRow[];
  name: (row: ReportRow) => string;
  mono?: boolean;
}) {
  return (
    <Section title={title}>
      <Table
        label={title}
        head={
          <>
            <th>{first}</th>
            <th className="num">API cost</th>
            <th className="num">Cached</th>
          </>
        }
        foot={
          <>
            <td>Total</td>
            <td className="num">{money(total(rows, (row) => row.cost))}</td>
            <td className="num">{money(total(rows, (row) => row.saved))}</td>
          </>
        }
      >
        {rows.map((row) => (
          <tr key={row.key}>
            <td className={mono ? "mono" : undefined}>{name(row)}</td>
            <td className="num mono">{money(row.cost)}</td>
            <td className="num mono">{money(row.saved)}</td>
          </tr>
        ))}
      </Table>
    </Section>
  );
}

function Sessions({ rows }: { rows: SessionRow[] }) {
  return (
    <Section title="Per session">
      <Table
        label="Per session"
        head={
          <>
            <th>Session</th>
            <th>Started</th>
            <th className="num">API cost</th>
            <th className="num">Cached</th>
          </>
        }
        foot={
          <>
            <td colSpan={2}>Total</td>
            <td className="num">{money(rows.reduce((sum, row) => sum + row.cost, 0))}</td>
            <td className="num">{money(rows.reduce((sum, row) => sum + row.saved, 0))}</td>
          </>
        }
      >
        {rows.map((row) => (
          <tr key={row.key}>
            <td>
              {row.project === null ? "Not started with grenier run" : `${row.project} · ${row.client ?? "agent"}`}
            </td>
            <td className="mono">
              {row.project === null || row.startedAt === null ? (
                ""
              ) : (
                <time title={exact(row.startedAt)}>{ago(row.startedAt)}</time>
              )}
            </td>
            <td className="num mono">{money(row.cost)}</td>
            <td className="num mono">{money(row.saved)}</td>
          </tr>
        ))}
      </Table>
    </Section>
  );
}

/** The sessions the loop guard paused: their requests wait until they are resumed, or time out. */
function Paused({ changed }: { changed: () => void }) {
  const { data, error, reload } = useLoad(loadPaused);
  const action = useAction(() => {
    reload();
    changed();
  });
  if (error) return <Problem error={error} />;
  if (!data || data.sessions.length === 0) return null;
  return (
    <>
      <Problem error={action.problem} />
      {data.sessions.map((session) => (
        <Notice
          key={session.id}
          kind="warn"
          more="Its requests wait until you resume it."
          action={
            <Button
              size="sm"
              icon={Play}
              busy={action.busy === `resume:${session.id}`}
              disabled={action.busy !== null}
              onClick={() =>
                void action.run(`resume:${session.id}`, async () => {
                  await api(`/sessions/${encodeURIComponent(session.id)}/resume`, { method: "POST" });
                  return `Resumed ${session.client ?? "the session"}`;
                })
              }
            >
              Resume
            </Button>
          }
        >
          Paused after a possible loop: {session.client ?? "an agent"}
          {session.repo ? ` in ${session.repo}` : ""}
          {session.pausedAt ? `, ${since(session.pausedAt)}` : ""}.
        </Notice>
      ))}
    </>
  );
}
