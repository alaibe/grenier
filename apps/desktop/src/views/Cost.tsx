import type { Overview, PausedSession, ReportRow, SessionRow } from "@grenier/core/api";
import { Play } from "lucide-react";
import { useEffect } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import {
  ago,
  Button,
  day,
  Empty,
  Figure,
  Figures,
  Loading,
  moment,
  money,
  Notice,
  Page,
  panel,
  Section,
  Table,
  useAction,
  useLoad,
} from "../ui.tsx";

const load = () => api<Overview>("/overview");
const loadPaused = () => api<{ sessions: PausedSession[] }>("/sessions/paused");
const REFRESH_MS = 30_000;

export function Cost(_: ViewProps) {
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
      title="Cost"
      intro="Your agents' requests through Grenier in the last 7 days, priced at API rates. Cached is what Anthropic's prompt cache took off."
    >
      <Notice message={error} />
      {!data && !error && <Loading what="usage" />}
      {data && data.paused > 0 && <Paused key={data.paused} changed={reload} />}
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
          <Spending title="Per project" first="Project" rows={data?.projects ?? []} name={(row) => row.key} />
          <Sessions rows={data?.sessions ?? []} />
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
    <Section title={title}>
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
    </Section>
  );
}

function Sessions({ rows }: { rows: SessionRow[] }) {
  return (
    <Section title="Per session">
      <Table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Started</th>
            <th className="text-right tabular-nums">API cost</th>
            <th className="text-right tabular-nums">Cached</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                {row.project === null ? "Not started with grenier run" : `${row.project} · ${row.client ?? "agent"}`}
              </td>
              <td className="tabular-nums">
                {row.project === null || row.startedAt === null ? "" : moment(row.startedAt)}
              </td>
              <td className="text-right tabular-nums">{money(row.cost)}</td>
              <td className="text-right tabular-nums">{money(row.saved)}</td>
            </tr>
          ))}
        </tbody>
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
  if (!data || data.sessions.length === 0) return <Notice message={error} />;
  return (
    <div className={`mb-6 ${panel("problem")} py-1 pr-2.5 pl-4`}>
      <Notice message={action.message?.problem ? action.message : null} />
      {data.sessions.map((session) => (
        <div className="flex items-center justify-between gap-4 py-1.5" key={session.id}>
          <p>
            Paused after a possible loop: <span className="font-medium">{session.client ?? "an agent"}</span>
            {session.repo ? ` in ${session.repo}` : ""}
            {session.pausedAt ? `, ${ago(session.pausedAt)}` : ""}. Its requests wait until you resume it.
          </p>
          <Button
            icon={Play}
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
