import { type FormEvent, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { Button, Empty, Input, Loading, Notice, Page, Table, useAction, useLoad } from "../ui.tsx";

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

interface FoundSkill {
  id: string;
  name: string;
  source: string;
  installs: number;
}

const STATE = { installed: "Installed", update: "Update waiting", available: "Not installed" } as const;

/** Skills found on skills.sh, which a click shares with the team from GitHub; each teammate still approves it. */
function FindSkills({ shared }: { shared: () => void }) {
  const [found, setFound] = useState<FoundSkill[] | null>(null);
  const action = useAction(shared);

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const words = String(new FormData(event.currentTarget).get("q") ?? "").trim();
    if (!words) return;
    void action.run("search", async () => {
      setFound((await api<{ skills: FoundSkill[] }>(`/installs/search?q=${encodeURIComponent(words)}`)).skills);
      return undefined;
    });
  };

  const add = (skill: FoundSkill) =>
    void action.run(`share:${skill.id}`, async () => {
      const done = await api<{ title: string; updated: boolean }>("/installs/share", {
        body: { source: skill.source, name: skill.name },
      });
      return {
        text: `${done.updated ? "Shared a new version of" : "Shared"} ${done.title} with the team. Install it above to use it here.`,
      };
    });

  return (
    <section className="mb-7">
      <h2 className="mb-1 font-semibold">Find a skill</h2>
      <p className="mb-2.5 text-md text-muted">
        Searches skills.sh with the words you type, and nothing else. Share fetches the skill from GitHub into the team,
        where each teammate reads it before installing it.
      </p>
      <form className="mb-3 flex max-w-150 gap-2" onSubmit={search}>
        <label className="flex-1">
          <span className="sr-only">Words to search for</span>
          <Input name="q" type="search" placeholder="release notes, react, testing…" autoComplete="off" />
        </label>
        <Button type="submit" disabled={action.busy !== null}>
          {action.busy === "search" ? "Searching…" : "Search"}
        </Button>
      </form>
      <Notice message={action.message} />
      {found && found.length === 0 && <Empty>No skill on skills.sh matches those words.</Empty>}
      {found && found.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th>Skill</th>
              <th className="text-right tabular-nums">Installs</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {found.map((skill) => (
              <tr key={skill.id}>
                <td className="whitespace-normal">
                  <span className="font-medium">{skill.name}</span>
                  <span className="block text-sm text-muted">{skill.source}</span>
                </td>
                <td className="text-right tabular-nums">{skill.installs.toLocaleString()}</td>
                <td>
                  <div className="flex justify-end">
                    <Button quiet disabled={action.busy !== null} onClick={() => add(skill)}>
                      {action.busy === `share:${skill.id}` ? "Sharing…" : "Share with the team"}
                    </Button>
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
                      onClick={() => go("knowledge", entry.id)}
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
          <FindSkills shared={reload} />
          {section("McpServer", "MCP servers", "grenier mcp share <name>")}
        </>
      )}
    </Page>
  );
}
