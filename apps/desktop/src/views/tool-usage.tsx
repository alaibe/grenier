import type { ToolUsage } from "@grenier/core/api";
import { folderName } from "@grenier/core/names";
import { useCallback } from "react";
import { api } from "../api.ts";
import { count, day, since, times } from "../format.ts";
import { BarChart } from "../ui/chart.tsx";
import { useLoad } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { Stat, Stats } from "../ui/stat.tsx";
import { Table } from "../ui/table.tsx";

/** A skill's or server's last 30 days here, for its `/usage` query: skill=, server= or shared=. */
export function UsageSection({ query, what }: { query: string; what: "skill" | "server" }) {
  const { data, error, reload } = useLoad(useCallback(() => api<ToolUsage>(`/usage?${query}`), [query]));
  const verb = what === "skill" ? "Loads" : "Calls";
  return (
    <Section
      title="Usage"
      description="The last 30 days on this machine, counted from Claude Code's own transcripts: nothing leaves it."
    >
      <Problem error={error} retry={reload} />
      {data &&
        (data.calls === 0 ? (
          <p className="text-muted">
            {what === "skill" ? "No agent loaded it" : "No agent called it"} here in the last 30 days.
          </p>
        ) : (
          <div className="grid gap-6">
            <Stats columns={3}>
              <Stat label={verb} value={count(data.calls)} lit change="last 30 days" />
              <Stat
                label="Failed"
                value={count(data.errors)}
                change={data.errors > 0 ? `${Math.round((data.errors / data.calls) * 100)}% of calls` : "none"}
              />
              <Stat label="Last used" value={since(data.lastAt)} change={times(data.projects.length, "project")} />
            </Stats>
            <BarChart
              label={`${verb} per day: ${data.days
                .filter((entry) => entry.calls > 0)
                .map((entry) => `${day(entry.day)} ${entry.calls}`)
                .join(", ")}`}
              series={[
                { name: verb, key: true },
                { name: "Failed", key: false },
              ]}
              groups={data.days.map((entry) => ({
                label: entry.day.slice(8),
                title: day(entry.day),
                values: [entry.calls, entry.errors],
              }))}
              format={count}
            />
            {what === "server" && (
              <Table
                label="Calls per tool"
                head={
                  <>
                    <th>Tool</th>
                    <th className="num">Calls</th>
                    <th className="num">Failed</th>
                    <th className="num">Last</th>
                  </>
                }
              >
                {data.tools.map((tool) => (
                  <tr key={tool.tool}>
                    <td className="mono">{tool.tool}</td>
                    <td className="num mono">{count(tool.calls)}</td>
                    <td className="num mono">{count(tool.errors)}</td>
                    <td className="num mono">{since(tool.lastAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
            <Table
              label={`${verb} per project`}
              head={
                <>
                  <th>Project</th>
                  <th className="num">{verb}</th>
                </>
              }
            >
              {data.projects.map((project) => (
                <tr key={project.project}>
                  <td title={project.project}>{project.project ? folderName(project.project) : "no folder"}</td>
                  <td className="num mono">{count(project.calls)}</td>
                </tr>
              ))}
            </Table>
          </div>
        ))}
    </Section>
  );
}
