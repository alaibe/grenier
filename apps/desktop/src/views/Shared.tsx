import type { SharedState } from "@grenier/core/api";
import { type FormEvent, type ReactNode, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { Button, Empty, Field, InlineForm, Input, Loading, Notice, Table, useAction, useLoad } from "../ui.tsx";

const load = () => api<{ shared: SharedState[] }>("/installs");

const STATE = { installed: "Installed", update: "Update waiting", available: "Not installed" } as const;

/** The skills or MCP servers the team shares, and what this machine has of each. */
export function Shared({ type, none, go }: { type: SharedState["type"]; none: ReactNode; go: ViewProps["go"] }) {
  const { data, error, reload } = useLoad(load);
  const [asking, setAsking] = useState<string | null>(null);
  const action = useAction(reload);
  const call = (key: string, path: string, method: string, done?: string) =>
    void action.run(key, async () => {
      await api(path, { method });
      return done ? { text: done } : undefined;
    });
  const install = (entry: SharedState, keys?: Record<string, string>) =>
    void action.run(`install:${entry.id}`, async () => {
      try {
        await api(`/installs/${entry.id}`, { body: keys ? { keys } : {} });
      } catch (error) {
        // A new key the update needs, or one never entered: ask for it here.
        if (entry.credentials.length > 0 && /needs your/.test((error as Error).message)) setAsking(entry.id);
        throw error;
      }
      setAsking(null);
      return { text: `Installed ${entry.title}. Restart Claude Code to load it.` };
    });
  const submitKeys = (entry: SharedState) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    install(entry, Object.fromEntries(entry.credentials.map((name) => [name, String(form.get(name) ?? "")])));
  };
  const rows = data?.shared.filter((entry) => entry.type === type) ?? [];
  return (
    <section className="mb-7">
      <Notice message={error ?? action.message} />
      {!data && !error && <Loading what={type === "Skill" ? "skills" : "MCP servers"} />}
      {data && rows.length === 0 && <Empty>{none}</Empty>}
      {rows.length > 0 && (
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
                    onClick={() => go("knowledge", entry.id)}
                  >
                    {entry.title}
                  </button>
                  {entry.description && <span className="block text-sm text-muted">{entry.description}</span>}
                  {entry.credentials.length > 0 && (
                    <span className="block text-sm text-muted">
                      Needs your {entry.credentials.join(", ")}: you enter it when you install, and it goes only into
                      your Claude Code config.
                    </span>
                  )}
                  {asking === entry.id && (
                    <InlineForm className="mt-2" onSubmit={submitKeys(entry)}>
                      {entry.credentials.map((name) => (
                        <Field key={name} className="w-56">
                          {name}
                          <Input name={name} type="password" required autoComplete="off" />
                        </Field>
                      ))}
                      <Button type="submit" disabled={action.busy !== null}>
                        Install
                      </Button>
                      <Button quiet onClick={() => setAsking(null)}>
                        Cancel
                      </Button>
                    </InlineForm>
                  )}
                </td>
                <td>{entry.author}</td>
                <td>{STATE[entry.state]}</td>
                <td>
                  <div className="flex justify-end gap-1.5">
                    {entry.state !== "installed" && asking !== entry.id && (
                      <Button
                        disabled={action.busy !== null}
                        onClick={() =>
                          entry.state === "available" && entry.credentials.length > 0
                            ? setAsking(entry.id)
                            : install(entry)
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
}
