import type { Machine, TeamMe } from "@grenier/core/api";
import { Trash2 } from "lucide-react";
import { useCallback } from "react";
import { api } from "../api.ts";
import { ago, exact } from "../format.ts";
import { PageCommands } from "../shell/commands.tsx";
import { stateTag } from "../states.ts";
import { Button } from "../ui/button.tsx";
import { useConfirm } from "../ui/dialog.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Section } from "../ui/page.tsx";
import { RowActions, Table } from "../ui/table.tsx";
import { Status, Tag } from "../ui/tag.tsx";

/** The team's machines; an admin removes any of them, a member their own. */
export function Machines({ me, removed }: { me: TeamMe | null; removed: (self: boolean) => void }) {
  const machines = useLoad(
    useCallback(() => api<{ machines: Machine[] }>("/team/machines").then((a) => a.machines), []),
  );
  const action = useAction();
  const { ask, dialog } = useConfirm();
  if (machines.error) return <Problem error={machines.error} retry={machines.reload} />;
  if (!machines.data) return null;
  const mayRemove = (machine: Machine) => me !== null && (me.role === "admin" || machine.member === me.name);
  const remove = (machine: Machine) =>
    void action.run(`remove:${machine.id}`, async () => {
      await api(`/team/devices/${encodeURIComponent(machine.id)}`, { method: "DELETE" });
      const self = machine.id === me?.deviceId;
      if (!self) machines.reload();
      removed(self);
      return `Removed ${machine.name}`;
    });
  const confirmRemove = (machine: Machine) =>
    ask({
      title: `Remove ${machine.name}?`,
      body:
        machine.id === me?.deviceId
          ? "It is the machine you are on: removing it signs it out of the team, and it syncs nothing after."
          : "It is signed out of the team. Joining again takes a new invite.",
      action: "Remove the machine",
      run: () => remove(machine),
    });
  return (
    <Section heading title="Machines">
      <PageCommands
        commands={machines.data.filter(mayRemove).map((machine) => ({
          id: `machine.remove:${machine.id}`,
          label: `Remove ${machine.name}…`,
          icon: Trash2,
          run: () => confirmRemove(machine),
        }))}
      />
      <Problem error={action.problem} />
      <Table
        label="Machines"
        head={
          <>
            <th>Machine</th>
            <th>Member</th>
            <th>State</th>
            <th>Last seen</th>
            <th className="num">Runs, 30 days</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </>
        }
      >
        {machines.data.map((machine) => (
          <tr key={machine.id}>
            <td>
              <span className="flex items-center gap-2">
                <span className="font-mono text-sm">{machine.name}</span>
                {machine.id === me?.deviceId && <Tag>this one</Tag>}
              </span>
            </td>
            <td>{machine.member}</td>
            <td>
              <Status {...stateTag(machine.state)} />
            </td>
            <td className="mono">
              <time title={machine.lastSeen ? exact(machine.lastSeen) : undefined}>{ago(machine.lastSeen)}</time>
            </td>
            <td className="num mono">{machine.runs ?? 0}</td>
            <RowActions>
              {mayRemove(machine) && (
                <Button
                  variant="danger"
                  size="sm"
                  icon={Trash2}
                  disabled={action.busy !== null}
                  onClick={() => confirmRemove(machine)}
                >
                  Remove
                </Button>
              )}
            </RowActions>
          </tr>
        ))}
      </Table>
      {dialog}
    </Section>
  );
}
