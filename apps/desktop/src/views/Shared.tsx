import type { SharedState } from "@grenier/core/api";
import { Check, Download, FileText, Trash2, Undo2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { Button } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Skeleton } from "../ui/empty.tsx";
import { Field, Input } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Menu } from "../ui/menu.tsx";
import { Problem } from "../ui/notice.tsx";
import { Table } from "../ui/table.tsx";
import { Status } from "../ui/tag.tsx";

const load = () => api<{ shared: SharedState[] }>("/installs");

function HereTag({ state }: { state: SharedState["state"] }) {
  if (state === "installed") return <Status kind="ok" word="installed" />;
  if (state === "update") return <Status kind="warn" word="update" />;
  return <Status kind="draft" word="not here" />;
}

/** The skills or MCP servers the team shares, and what this machine has of each. */
export function Shared({ type, none, go }: { type: SharedState["type"]; none: ReactNode; go: ViewProps["go"] }) {
  const { data, error, reload } = useLoad(load);
  const [asking, setAsking] = useState<SharedState | null>(null);
  const action = useAction(reload);
  const what = type === "Skill" ? "skill" : "server";

  const install = (entry: SharedState, keys?: Record<string, string>) =>
    void action.run(
      `install:${entry.id}`,
      async () => {
        try {
          await api(`/installs/${entry.id}`, { body: keys ? { keys } : {} });
        } catch (error) {
          // A new key the update needs, or one never entered: ask for it.
          if (entry.credentials.length > 0 && /needs your/.test((error as Error).message)) setAsking(entry);
          throw error;
        }
        setAsking(null);
        return `Installed ${entry.title}: restart Claude Code to load it`;
      },
      "Installing",
    );
  const remove = (entry: SharedState) =>
    void action.run(`remove:${entry.id}`, async () => {
      await api(`/installs/${entry.id}`, { method: "DELETE" });
      // Putting it back needs the person's keys again when it has some: then there is nothing to undo with.
      return entry.credentials.length === 0
        ? { text: `Removed ${entry.title}`, undo: () => install(entry) }
        : `Removed ${entry.title}`;
    });
  const rollBack = (entry: SharedState) =>
    void action.run(`rollback:${entry.id}`, async () => {
      await api(`/installs/${entry.id}/rollback`, { method: "POST" });
      return `Rolled ${entry.title} back to the version before`;
    });
  const start = (entry: SharedState) =>
    entry.state === "available" && entry.credentials.length > 0 ? setAsking(entry) : install(entry);

  const rows = data?.shared.filter((entry) => entry.type === type) ?? [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: start reads the action as it is when it runs
  const commands = useMemo<Command[]>(
    () =>
      rows
        .filter((entry) => entry.state !== "installed")
        .map((entry) => ({
          id: `install:${entry.id}`,
          label: `${entry.state === "update" ? "Approve the update of" : "Install"} ${entry.title}`,
          icon: entry.state === "update" ? Check : Download,
          run: () => start(entry),
        })),
    [data],
  );
  useCommands(commands);

  return (
    <div className="grid gap-3">
      <Problem error={error ?? action.problem} />
      {!data && !error && <Skeleton rows={3} shape="table" />}
      {data && rows.length === 0 && <p className="text-muted">{none}</p>}
      {rows.length > 0 && (
        <Table
          label={type === "Skill" ? "Shared skills" : "Shared MCP servers"}
          head={
            <>
              <th>Name</th>
              <th>Shared by</th>
              <th>Here</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </>
          }
        >
          {rows.map((entry) => (
            <tr key={entry.id}>
              <td className="py-1.5 whitespace-normal">
                <span className="block font-semibold">{entry.title}</span>
                {entry.description && <span className="block text-sm text-muted">{entry.description}</span>}
                {entry.credentials.length > 0 && (
                  <span className="block text-sm text-muted">
                    Needs your {entry.credentials.join(", ")}: it goes only into your Claude Code config.
                  </span>
                )}
              </td>
              <td>{entry.author}</td>
              <td>
                <HereTag state={entry.state} />
              </td>
              <td className="w-px">
                <div className="flex items-center justify-end gap-1">
                  {entry.state !== "installed" && (
                    <Button
                      size="sm"
                      icon={entry.state === "update" ? Check : Download}
                      busy={action.busy === `install:${entry.id}`}
                      disabled={action.busy !== null}
                      onClick={() => start(entry)}
                    >
                      {entry.state === "update" ? "Approve the update" : "Install"}
                    </Button>
                  )}
                  <span className="row-actions">
                    <Menu
                      label={`More for ${entry.title}`}
                      items={[
                        { label: `Open the ${what}'s page`, icon: FileText, run: () => go("knowledge", entry.id) },
                        ...(entry.canRollBack
                          ? [
                              {
                                label: "Roll back",
                                icon: Undo2,
                                disabled: action.busy !== null,
                                run: () => rollBack(entry),
                              },
                            ]
                          : []),
                        ...(entry.state !== "available"
                          ? [
                              {
                                label: "Remove",
                                icon: Trash2,
                                danger: true,
                                disabled: action.busy !== null,
                                run: () => remove(entry),
                              },
                            ]
                          : []),
                      ]}
                    />
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {asking && (
        <Dialog
          title={`Install ${asking.title}`}
          action="Install"
          busy={action.busy !== null}
          onCancel={() => setAsking(null)}
          onAction={(form) =>
            install(asking, Object.fromEntries(asking.credentials.map((name) => [name, String(form.get(name) ?? "")])))
          }
        >
          <p>Your keys go only into its entry in your own Claude Code config: never to the team, a log or a store.</p>
          <Problem error={action.problem} />
          {asking.credentials.map((name) => (
            <Field key={name} label={name}>
              <Input name={name} type="password" mono required autoComplete="off" />
            </Field>
          ))}
        </Dialog>
      )}
    </div>
  );
}
