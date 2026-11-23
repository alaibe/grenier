import { type ReactNode, useEffect } from "react";
import type { ViewProps } from "../App.tsx";
import { api, type Overview, type PausedSession, type ReportRow, type SessionRow } from "../api.ts";
import {
  ago,
  Button,
  count,
  day,
  Empty,
  Figure,
  Figures,
  Loading,
  moment,
  money,
  Notice,
  Page,
  Table,
  times,
  useAction,
  useLoad,
} from "../ui.tsx";

const load = () => api<Overview>("/overview");
const loadPaused = () => api<{ sessions: PausedSession[] }>("/sessions/paused");
const loadEffectiveness = () => api<Effectiveness>("/effectiveness");

interface Effectiveness {
  spend: number;
  effective: number;
  landedShare: number | null;
  rediscovery: number;
  perIssue: { key: string; cost: number; sessions: number }[];
  pending: number;
  sessions: number;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** What the last 30 days' spend turned into, worked out on this machine and kept here. */
function Outcomes() {
  const { data } = useLoad(loadEffectiveness);
  if (!data) return null;
  if (data.sessions === 0) {
    return data.pending > 0 ? (
      <p className="mb-7 text-sm text-muted">
        Effectiveness shows once sessions are 14 days old: their edits need that long to land.
      </p>
    ) : null;
  }
  return (
    <section className="mb-7">
      <h2 className="mb-2.5 font-semibold">What the spend became, last 30 days</h2>
      <Figures className="grid-cols-3">
        <Figure
          value={percent(data.spend > 0 ? data.effective / data.spend : 0)}
          label={`effective: ${money(data.effective)} of ${money(data.spend)}`}
          title="Spend weighted by how much of what each session wrote landed, or by whether agents used what it recorded"
        />
        <Figure
          value={data.landedShare === null ? "–" : percent(data.landedShare)}
          label="of written lines on the default branch 14 days later"
        />
        <Figure value={money(data.rediscovery)} label="spent reading what a recorded answer covered" />
      </Figures>
      {data.perIssue.length > 0 && (
        <p className="mt-2 text-sm text-muted">
          Cost per issue:{" "}
          {data.perIssue
            .slice(0, 6)
            .map((issue) => `${issue.key} ${money(issue.cost)}`)
            .join(" · ")}
        </p>
      )}
      <p className="mt-1 text-sm text-muted">These numbers stay on this machine.</p>
    </section>
  );
}
const REFRESH_MS = 30_000;

export function Dashboard({ go }: ViewProps) {
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
  const cost = days.reduce((sum, row) => sum + row.cost, 0);
  const cached = days.reduce((sum, row) => sum + row.saved, 0);

  return (
    <Page
      title="Dashboard"
      intro="What the store holds, and your agents' requests through Grenier in the last 7 days, priced at API rates. Cached is what Anthropic's prompt cache took off."
    >
      <Notice message={error} />
      {!data && !error && <Loading what="usage" />}
      {data && data.paused > 0 && <Paused key={data.paused} changed={reload} />}
      {data && (
        <Figures className="mb-7 grid-cols-3">
          <Figure value={count(data.records)} label="records in the store" />
          <Figure value={count(data.hits)} label="times agents used one" />
          <Figure
            value={data.team ? ago(data.team.lastSync) : "no team"}
            label={
              data.team
                ? `last sync${data.waiting > 0 ? `, ${times(data.waiting, "change")} waiting` : ""}`
                : "everything stays here"
            }
          />
        </Figures>
      )}
      {data && data.records === 0 && (
        <Banner>
          <p>Nothing in the store yet. Give your agents Grenier's MCP server, and what they learn is kept.</p>
          <Button onClick={() => go("store")}>Open the store</Button>
        </Banner>
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
            <Figure value={money(cached)} label="cached: the prompt-cache discount" />
          </Figures>
          <Outcomes />
          <Spending title="Per project" first="Project" rows={data?.projects ?? []} name={(row) => row.key} />
          <Sessions rows={data?.sessions ?? []} open={(id) => go("traces", id)} />
          <Spending
            title="Per day"
            first="Day"
            rows={[...days].sort((a, b) => b.key.localeCompare(a.key))}
            name={(row) => day(row.key)}
          />
        </>
      )}
    </Page>
  );
}

function Banner({ problem = false, children }: { problem?: boolean; children: ReactNode }) {
  const look = problem ? "border-problem bg-problem-soft" : "border-accent bg-accent-soft";
  return (
    <div className={`mb-5 flex items-center justify-between gap-4 rounded-xl border py-2.5 pr-2.5 pl-4 ${look}`}>
      {children}
    </div>
  );
}

function Spending({
  title,
  first,
  rows,
  name,
}: {
  title: string;
  first: string;
  rows: ReportRow[];
  name: (row: ReportRow) => string;
}) {
  return (
    <section className="mb-7">
      <h2 className="mb-2.5 font-semibold">{title}</h2>
      <Table>
        <thead>
          <tr>
            <th>{first}</th>
            <th className="text-right tabular-nums">API cost</th>
            <th className="text-right tabular-nums">Cached</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{name(row)}</td>
              <td className="text-right tabular-nums">{money(row.cost)}</td>
              <td className="text-right tabular-nums">{money(row.saved)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

function asked(row: SessionRow): string {
  if (row.asks === null) return "–";
  if (row.asks === 0) return "never";
  return `${count(row.asks)} (${times(row.hits ?? 0, "hit")})`;
}

function Sessions({ rows, open }: { rows: SessionRow[]; open: (id: string) => void }) {
  return (
    <section className="mb-7">
      <h2 className="mb-2.5 font-semibold">Per session</h2>
      <Table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Started</th>
            <th
              className="text-right tabular-nums"
              title="Times the agent called recall, and how many found an answer that still holds"
            >
              Recalled
            </th>
            <th className="text-right tabular-nums">API cost</th>
            <th className="text-right tabular-nums">Cached</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                {row.project === null ? "Not started with grenier run" : `${row.project} · ${row.client ?? "agent"}`}
                {row.traced && (
                  <button
                    type="button"
                    className="ml-2 cursor-pointer text-accent underline underline-offset-2"
                    onClick={() => open(row.key)}
                  >
                    Trace
                  </button>
                )}
              </td>
              <td className="tabular-nums">
                {row.project === null || row.startedAt === null ? "" : moment(row.startedAt)}
              </td>
              <td className="text-right tabular-nums">{asked(row)}</td>
              <td className="text-right tabular-nums">{money(row.cost)}</td>
              <td className="text-right tabular-nums">{money(row.saved)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
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
