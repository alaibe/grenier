import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { Button, Empty, Loading, Notice, Page, Table, useAction, useLoad } from "../ui.tsx";

interface SharedState {
  id: string;
  type: "Skill" | "McpServer";
  title: string;
  description: string;
  author: string;
  recommended: boolean;
  state: "installed" | "update" | "available";
  credentials: string[];
  canRollBack: boolean;
}

const load = () => api<{ shared: SharedState[]; auto: boolean }>("/installs");

const STATE = { installed: "Installed", update: "Update waiting", available: "Not installed" } as const;

/** The team's skills and MCP servers: installed into Claude Code on this machine once approved, by their hash. */
export function Skills({ go }: ViewProps) {
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);
  const call = (key: string, path: string, method: string, body?: unknown, done?: string) =>
    void action.run(key, async () => {
      await api(path, { method, ...(body === undefined ? {} : { body }) });
      return done ? { text: done } : undefined;
    });

  const section = (type: SharedState["type"], title: string, none: string) => {
    const rows = data?.shared.filter((entry) => entry.type === type) ?? [];
    return (
      <section className="mb-7">
        <h2 className="mb-2.5 font-semibold">{title}</h2>
        {rows.length === 0 ? (
          <Empty>
            <code>{none}</code>
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Shared by</th>
                <th>Here</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-normal">
                    <button
                      type="button"
                      className="cursor-pointer font-medium hover:underline"
                      onClick={() => go("store", entry.id)}
                    >
                      {entry.title}
                    </button>
                    {entry.recommended && (
                      <span className="ml-2 rounded-[5px] border border-accent px-1.5 text-xs leading-5 text-accent">
                        recommended
                      </span>
                    )}
                    {entry.description && <span className="block text-sm text-muted">{entry.description}</span>}
                    {entry.credentials.length > 0 && (
                      <span className="block text-sm text-muted">
                        Reads {entry.credentials.join(", ")} from your environment.
                      </span>
                    )}
                  </td>
                  <td>{entry.author}</td>
                  <td>{STATE[entry.state]}</td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      {entry.state !== "installed" && (
                        <Button
                          disabled={action.busy !== null}
                          onClick={() =>
                            call(
                              `install:${entry.id}`,
                              `/installs/${entry.id}`,
                              "POST",
                              undefined,
                              `Installed ${entry.title}. Restart Claude Code to load it.`,
                            )
                          }
                        >
                          {entry.state === "update" ? "Approve the update" : "Install"}
                        </Button>
                      )}
                      {entry.canRollBack && (
                        <Button
                          quiet
                          disabled={action.busy !== null}
                          onClick={() => call(`rollback:${entry.id}`, `/installs/${entry.id}/rollback`, "POST")}
                        >
                          Roll back
                        </Button>
                      )}
                      {entry.state !== "available" && (
                        <Button
                          quiet
                          disabled={action.busy !== null}
                          onClick={() => call(`remove:${entry.id}`, `/installs/${entry.id}`, "DELETE")}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    );
  };

  return (
    <Page
      title="Skills and servers"
      intro="What the team shares for its agents. Installing one approves it as it is now: a later change waits for your approval, unless an admin recommends it and you let recommended ones update by themselves."
    >
      <Notice message={error ?? action.message} />
      {!data && !error && <Loading what="skills" />}
      {data && (
        <>
          <section className="mb-7 rounded-xl border border-line bg-panel px-5 py-4">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 accent-accent"
                checked={data.auto}
                disabled={action.busy !== null}
                onChange={(event) => call("auto", "/installs/auto", "PUT", { on: event.currentTarget.checked })}
              />
              <span>
                <span className="font-medium">Install recommended ones by themselves</span>
                <span className="mt-0.5 block text-md text-muted">
                  The skills and servers an admin recommends install and update on this machine without asking. Each
                  update can be rolled back.
                </span>
              </span>
            </label>
          </section>
          {section("Skill", "Skills", "grenier skills share <folder>")}
          {section("McpServer", "MCP servers", "grenier mcp share <name>")}
        </>
      )}
    </Page>
  );
}
