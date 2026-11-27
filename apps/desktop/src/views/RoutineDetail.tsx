import type { LocalRun, RoutineView } from "@grenier/core/api";
import type { RoutineMode } from "@grenier/core/routines";
import { CirclePlay, Pause, Pencil, Play, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { MarkdownEditor } from "../editor/markdown-editor.tsx";
import { ago, exact } from "../format.ts";
import { PageCommands } from "../shell/commands.tsx";
import { DetailBar, ItemMeta, ItemName, Reading, useItemTitle } from "../shell/regions.tsx";
import { stateTag } from "../states.ts";
import { Button } from "../ui/button.tsx";
import { Menu } from "../ui/menu.tsx";
import { Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { Table } from "../ui/table.tsx";
import { Status } from "../ui/tag.tsx";
import { TeamRuns } from "./TeamRuns.tsx";

export const MODE_SAYS: Record<RoutineMode, string> = {
  "read-only": "reads only",
  shadow: "says what it would do",
  limited: "acts, a set number of times a day",
  on: "acts, auto mode judging each step",
};

/** A routine's tag: running, or paused by an admin. */
export const routineTag = (routine: RoutineView) => <Status {...stateTag(routine.state)} />;

/** One routine: its prompt, how its admin set it, Run now, and its runs here and on the team. */
export function RoutineDetail({
  routine,
  runs,
  busy,
  going,
  admin,
  problem,
  notice,
  pause,
  resume,
  remove,
  run,
  edit,
}: {
  routine: RoutineView;
  runs: LocalRun[];
  busy: boolean;
  going: boolean;
  admin: boolean;
  problem: string | null;
  notice: ReactNode;
  pause: () => void;
  resume: () => void;
  remove: () => void;
  run: () => void;
  edit: () => void;
}) {
  useItemTitle(routine.title);
  const when = routine.schedule ? `${routine.schedule} UTC` : "run by hand";
  const how = routine.mode === "limited" ? `limited, ${routine.limit} actions a day` : routine.mode;
  const running = routine.state === "running";
  return (
    <article className="flex h-full min-w-0 flex-col overflow-y-auto">
      <DetailBar crumb={<>Team / {routine.title}</>}>
        {routineTag(routine)}
        {admin && (
          <Button icon={Pencil} size="sm" onClick={edit}>
            Edit
          </Button>
        )}
        {admin && (
          <Button icon={running ? Pause : CirclePlay} size="sm" disabled={busy} onClick={running ? pause : resume}>
            {running ? "Pause" : "Resume"}
          </Button>
        )}
        {admin && (
          <Menu label="More" items={[{ label: "Remove from the team", icon: Trash2, danger: true, run: remove }]} />
        )}
        <Button
          icon={Play}
          size="sm"
          disabled={busy || going || !running || !routine.prompt.trim()}
          title={going ? "A run is going on this machine" : running ? undefined : "Paused: an admin resumes it first"}
          onClick={run}
        >
          Run now
        </Button>
      </DetailBar>
      <Reading gap="gap-6">
        <div>
          <ItemName>{routine.title}</ItemName>
          <ItemMeta>
            {when} · {routine.agent} · {how}: {MODE_SAYS[routine.mode]} · by {routine.author}
          </ItemMeta>
        </div>
        {(problem || notice) && (
          <div className="grid gap-2">
            <Problem error={problem} />
            {notice}
          </div>
        )}
        {routine.prompt.trim() ? (
          <MarkdownEditor
            key={routine.prompt}
            value={routine.prompt}
            editable={false}
            label={`What ${routine.title} does`}
          />
        ) : (
          <p className="text-muted">No text yet: it runs nowhere until an admin writes what it does.</p>
        )}
        {runs.length > 0 && (
          <Section heading title="Runs here">
            <Table
              label={`Recent runs of ${routine.title} here`}
              head={
                <>
                  <th>State</th>
                  <th>Started by</th>
                  <th>When</th>
                  <th className="num">Actions</th>
                  <th>Result</th>
                </>
              }
            >
              {runs.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <Status {...stateTag(entry.status)} />
                  </td>
                  <td>{entry.trigger}</td>
                  <td className="mono">
                    <time title={exact(entry.startedAt)}>{ago(entry.startedAt)}</time>
                  </td>
                  <td className="num mono">{entry.actions}</td>
                  <td className="max-w-90 truncate text-muted" title={entry.result ?? undefined}>
                    {entry.result}
                  </td>
                </tr>
              ))}
            </Table>
          </Section>
        )}
        <TeamRuns routine={routine.id} />
      </Reading>
      {/* Run, Pause and Resume are the list's commands, one for each routine. */}
      <PageCommands
        commands={
          admin
            ? [
                { id: "routine.edit", label: "Edit the routine…", icon: Pencil, run: edit },
                { id: "routine.remove", label: "Remove from the team…", icon: Trash2, run: remove },
              ]
            : []
        }
      />
    </article>
  );
}
