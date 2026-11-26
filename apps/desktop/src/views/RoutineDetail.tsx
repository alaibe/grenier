import type { BuiltinView, LocalRun, RoutineView } from "@grenier/core/api";
import type { RoutineMode } from "@grenier/core/routines";
import { ArrowRight, Check, CircleStop, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MarkdownEditor } from "../editor/markdown-editor.tsx";
import { ago, exact } from "../format.ts";
import { DetailBar, ItemMeta, ItemName, Reading, useItemTitle } from "../shell/regions.tsx";
import { stateTag } from "../states.ts";
import { Button, Primary } from "../ui/button.tsx";
import { Select } from "../ui/field.tsx";
import { Menu } from "../ui/menu.tsx";
import { Notice, Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { Table } from "../ui/table.tsx";
import { Status } from "../ui/tag.tsx";
import { TeamRuns } from "./TeamRuns.tsx";

const MODES: RoutineMode[] = ["read-only", "shadow", "limited", "on"];

const MODE_SAYS: Record<RoutineMode, string> = {
  "read-only": "reads only",
  shadow: "says what it would do",
  limited: "acts, a set number of times a day",
  on: "acts, auto mode judging each step",
};

/** Where a routine stands on this machine, for its row: approved as it is, changed since, or not approved. */
export function approvalTag(routine: RoutineView) {
  return <Status {...stateTag(routine.approval?.current ? "approved" : routine.approval ? "changed" : "not-here")} />;
}

/** A routine Grenier ships, not added yet: what it does, and Add. */
export function BuiltinDetail({
  builtin,
  adding,
  member,
  busy,
  problem,
  add,
  createTeam,
}: {
  builtin: BuiltinView;
  adding: boolean;
  member: boolean;
  busy: boolean;
  problem: string | null;
  add: () => void;
  createTeam: () => void;
}) {
  return (
    <article className="flex h-full min-w-0 flex-col overflow-y-auto">
      <DetailBar crumb={<>Built in / {builtin.title}</>}>
        {adding && (
          <Primary size="sm" icon={Plus} busy={busy} onClick={add}>
            Add it
          </Primary>
        )}
      </DetailBar>
      <Reading gap="gap-4">
        <div>
          <ItemName>{builtin.title}</ItemName>
          <ItemMeta>
            {builtin.schedule} UTC · {builtin.local ? "no agent, no cost" : "an agent"} ·{" "}
            {builtin.collector ? "each person's own, written to their Me" : "for the team"}
          </ItemMeta>
        </div>
        <Problem error={problem} />
        {member && <Notice kind="info">An admin adds it for the team.</Notice>}
        {!adding && !member && (
          <Notice
            kind="info"
            action={
              <Button size="sm" trailing={ArrowRight} onClick={createTeam}>
                Create a team
              </Button>
            }
          >
            Routines run through a team's store: adding one needs a team, which can be just you.
          </Notice>
        )}
        <MarkdownEditor value={builtin.prompt} editable={false} label={`What ${builtin.title} does`} />
      </Reading>
    </article>
  );
}

/** One routine: its prompt, its mode and approval here, Run now, and its runs here and on the team. */
export function RoutineDetail({
  routine,
  runs,
  busy,
  going,
  member,
  team,
  problem,
  notice,
  approve,
  stop,
  remove,
  run,
  edit,
}: {
  routine: RoutineView;
  runs: LocalRun[];
  busy: boolean;
  going: boolean;
  member: boolean;
  team: boolean;
  problem: string | null;
  notice: ReactNode;
  approve: (mode: RoutineMode) => void;
  stop: () => void;
  remove: () => void;
  run: () => void;
  edit: () => void;
}) {
  const [mode, setMode] = useState<RoutineMode>(routine.approval?.mode ?? "read-only");
  useItemTitle(routine.title);
  // The bar approves; here only a change of mode of an approved routine needs one.
  const remode = routine.approval?.current && routine.approval.mode !== mode;
  const when = routine.schedule ? `${routine.schedule} UTC` : "run by hand";
  const group = routine.builtin ? "Built in" : routine.collector ? "Each person's own" : "Team";
  return (
    <article className="flex h-full min-w-0 flex-col overflow-y-auto">
      <DetailBar
        crumb={
          <>
            {group} / {routine.title}
          </>
        }
      >
        {approvalTag(routine)}
        {!member && (
          <Button icon={Pencil} size="sm" onClick={edit}>
            Edit
          </Button>
        )}
        {(routine.approval || !member) && (
          <Menu
            label="More"
            items={[
              ...(routine.approval ? [{ label: "Stop running here", icon: CircleStop, run: stop }] : []),
              ...(member ? [] : [{ label: "Remove from the team", icon: Trash2, danger: true, run: remove }]),
            ]}
          />
        )}
        {routine.approval?.current ? (
          <Button
            icon={Play}
            size="sm"
            disabled={busy || going || !routine.prompt.trim()}
            title={going ? "A run is going on this machine" : undefined}
            onClick={run}
          >
            Run now
          </Button>
        ) : (
          <Button icon={Check} size="sm" disabled={busy || !routine.prompt.trim()} onClick={() => approve(mode)}>
            {routine.approval ? "Approve the change" : `Approve to run here, ${mode}`}
          </Button>
        )}
      </DetailBar>
      <Reading gap="gap-6">
        <div>
          <ItemName>{routine.title}</ItemName>
          <ItemMeta>
            {when} · {routine.agent} · by {routine.author}
            {routine.collector ? " · each person's own" : ""}
          </ItemMeta>
        </div>
        {(problem || notice || (routine.approval && !routine.approval.current)) && (
          <div className="grid gap-2">
            <Problem error={problem} />
            {notice}
            {routine.approval && !routine.approval.current && (
              <Notice kind="warn">
                Changed since you approved it: it runs here again once you approve the change.
              </Notice>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-72">
            <Select
              aria-label={`Mode of ${routine.title}`}
              value={mode}
              onChange={(event) => setMode(event.currentTarget.value as RoutineMode)}
            >
              {MODES.map((name) => (
                <option key={name} value={name}>
                  {name}: {MODE_SAYS[name]}
                </option>
              ))}
            </Select>
          </div>
          {remode && (
            <Button icon={Check} disabled={busy} onClick={() => approve(mode)}>
              Approve in this mode
            </Button>
          )}
        </div>
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
        {team && <TeamRuns routine={routine.id} />}
      </Reading>
    </article>
  );
}
