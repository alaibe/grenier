import { type FormEvent, type ReactNode, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { Button, Empty, Field, Input, Loading, Notice, Page, Part, Table, useAction, useLoad } from "../ui.tsx";

interface SharedState {
  id: string;
  type: "Skill" | "McpServer";
  title: string;
  description: string;
  author: string;
  state: "installed" | "update" | "available";
  credentials: string[];
  canRollBack: boolean;
}

const load = () => api<{ shared: SharedState[] }>("/installs");

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

/** The skills or MCP servers the team shares, and what this machine has of each. */
function Shared({ type, none, go }: { type: SharedState["type"]; none: ReactNode; go: ViewProps["go"] }) {
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
                    <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={submitKeys(entry)}>
                      {entry.credentials.map((name) => (
                        <label key={name} className="flex flex-col gap-1 text-sm font-medium">
                          {name}
                          <input
                            name={name}
                            type="password"
                            required
                            autoComplete="off"
                            className="h-8 w-56 rounded-md border border-line-strong bg-panel px-2.5"
                          />
                        </label>
                      ))}
                      <Button type="submit" disabled={action.busy !== null}>
                        Install
                      </Button>
                      <Button quiet onClick={() => setAsking(null)}>
                        Cancel
                      </Button>
                    </form>
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

const textarea =
  "min-h-32 w-full rounded-md border border-line-strong bg-panel px-2.5 py-2 font-mono text-md leading-relaxed";

/** A form behind a button, as admins add a skill or a server: it closes once what it made is shared. */
function Adding({ label, children }: { label: string; children: (done: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button quiet onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <section className="mb-7 rounded-xl border border-line bg-panel px-5 py-4">
      {children(() => setOpen(false))}
    </section>
  );
}

/** A skill written in the app: its SKILL.md, from a name, a one-line description and the instructions. */
function NewSkill({ added }: { added: () => void }) {
  const action = useAction(added);
  return (
    <Adding label="New skill">
      {(done) => (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void action
              .run("skill", async () => {
                await api("/installs/skill", {
                  body: {
                    name: String(form.get("name") ?? ""),
                    description: String(form.get("description") ?? ""),
                    instructions: String(form.get("instructions") ?? ""),
                  },
                });
                return { text: "Shared with the team. Each person installs it, or not." };
              })
              .then((ok) => ok && done());
          }}
        >
          <Notice message={action.message} />
          <Field>
            Name, in lowercase with dashes
            <Input name="name" placeholder="release-notes" required pattern="[a-z0-9][a-z0-9\-]*" />
          </Field>
          <Field>
            When an agent should use it, in one line
            <Input
              name="description"
              placeholder="Writes release notes from the pull requests merged since the last tag."
              required
            />
          </Field>
          <Field>
            Instructions, in Markdown
            <textarea name="instructions" className={textarea} required />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={action.busy !== null}>
              Share with the team
            </Button>
            <Button quiet onClick={done}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Adding>
  );
}

interface FoundServer {
  name: string;
  title: string;
  description: string;
  version: string;
  config: Record<string, unknown>;
  credentials: string[];
  website: string | null;
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** "Authorization: Bearer {api_key}" lines into headers, and the {names} in them into the keys each person enters. */
function templates(text: string): { values: Record<string, string>; names: string[] } {
  const values: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.indexOf(line.includes(":") ? ":" : "=");
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const names = Object.values(values).flatMap((value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string));
  return { values, names: [...new Set(names)] };
}

/** An MCP server added for the team: found in the MCP Registry, or written by hand. */
function AddServer({ added }: { added: () => void }) {
  const action = useAction(added);
  const [words, setWords] = useState("");
  const [found, setFound] = useState<FoundServer[] | null>(null);
  const [by, setBy] = useState<"registry" | "hand">("registry");
  const share = (body: Record<string, unknown>, done: () => void) =>
    void action
      .run(`share:${String(body.title)}`, async () => {
        await api("/installs/server", { body });
        return { text: `Shared ${String(body.title)}. Each person installs it, with their own keys.` };
      })
      .then((ok) => ok && done());
  return (
    <Adding label="Add a server">
      {(done) => (
        <div className="grid gap-3">
          <Notice message={action.message} />
          <fieldset className="inline-flex w-fit overflow-hidden rounded-md border border-line-strong text-sm">
            <legend className="sr-only">How to add it</legend>
            {(
              [
                ["registry", "From the MCP Registry"],
                ["hand", "By hand"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={by === value}
                className={`h-7 cursor-pointer px-2.5 ${by === value ? "bg-accent text-accent-fg" : "bg-panel hover:bg-hover"}`}
                onClick={() => setBy(value)}
              >
                {label}
              </button>
            ))}
          </fieldset>
          {by === "registry" ? (
            <>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void action.run("search", async () => {
                    setFound(
                      (await api<{ servers: FoundServer[] }>(`/installs/registry?q=${encodeURIComponent(words)}`))
                        .servers,
                    );
                    return undefined;
                  });
                }}
              >
                <Input
                  type="search"
                  placeholder="Search registry.modelcontextprotocol.io: only these words are sent"
                  value={words}
                  onChange={(event) => setWords(event.currentTarget.value)}
                />
                <Button type="submit" disabled={action.busy !== null || !words.trim()}>
                  Search
                </Button>
              </form>
              {found?.length === 0 && <p className="text-sm text-muted">Nothing Grenier can add as it is.</p>}
              {found && found.length > 0 && (
                <ul className="divide-y divide-line">
                  {found.map((server) => (
                    <li key={server.name} className="flex items-start justify-between gap-3 py-2">
                      <span className="min-w-0">
                        <span className="font-medium">{server.title}</span>{" "}
                        <span className="text-sm text-muted">
                          {server.name} {server.version}
                        </span>
                        {server.description && <span className="block text-sm text-muted">{server.description}</span>}
                        {server.credentials.length > 0 && (
                          <span className="block text-sm text-muted">
                            Each person enters {server.credentials.join(", ")}.
                          </span>
                        )}
                        {server.config.command === "docker" && (
                          <span className="block text-sm text-muted">
                            Runs in Docker: each person needs it installed.
                          </span>
                        )}
                      </span>
                      <Button
                        disabled={action.busy !== null}
                        onClick={() =>
                          share(
                            {
                              title: server.name.split("/").at(-1) ?? server.title,
                              description: server.description,
                              config: server.config,
                              credentials: server.credentials,
                            },
                            done,
                          )
                        }
                      >
                        Add
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const url = String(form.get("url") ?? "").trim();
                const pairs = templates(String(form.get("pairs") ?? ""));
                const command = lines(String(form.get("command") ?? "").replace(/ +/g, "\n"));
                const plain = lines(String(form.get("keys") ?? "").replace(/,/g, "\n"));
                share(
                  {
                    title: String(form.get("title") ?? ""),
                    description: String(form.get("description") ?? ""),
                    config: url
                      ? { url, headers: pairs.values }
                      : { command: command[0] ?? "", args: command.slice(1), env: pairs.values },
                    credentials: [...new Set([...pairs.names, ...plain])],
                  },
                  done,
                );
              }}
            >
              <Field>
                Name
                <Input name="title" placeholder="sentry" required />
              </Field>
              <Field>
                What it gives agents, in one line
                <Input name="description" placeholder="Sentry's issues and events, read-only." />
              </Field>
              <Field>
                Its URL, for a remote server
                <Input name="url" type="url" placeholder="https://mcp.sentry.dev/mcp" />
              </Field>
              <Field>
                Or the command that runs it, with a pinned version
                <Input name="command" placeholder="npx -y @sentry/mcp-server@1.2.0" />
              </Field>
              <Field>
                Headers (URL) or environment (command), one per line: {"{name}"} is a key each person enters
                <textarea name="pairs" className={textarea} placeholder={"Authorization: Bearer {sentry_token}"} />
              </Field>
              <Field>
                Other keys each person enters, as environment variables
                <Input name="keys" placeholder="SENTRY_TOKEN, SENTRY_ORG" />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" disabled={action.busy !== null}>
                  Share with the team
                </Button>
                <Button quiet onClick={done}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {by === "registry" && (
            <div>
              <Button quiet onClick={done}>
                Close
              </Button>
            </div>
          )}
        </div>
      )}
    </Adding>
  );
}

export function Skills({ go, member }: ViewProps) {
  const [round, setRound] = useState(0);
  const again = () => setRound((n) => n + 1);
  return (
    <Page
      title="Skills"
      intro="What the team shares for its agents. An admin adds a skill; you install it or not. Installing one approves it as it is now: a later change waits for your approval again."
    >
      <Shared
        key={round}
        type="Skill"
        go={go}
        none={
          <p>{member ? "No skill shared yet." : "No skill shared yet. Write one, or find one on skills.sh below."}</p>
        }
      />
      {!member && <NewSkill added={again} />}
      {!member && <FindSkills shared={again} />}
    </Page>
  );
}

/** For the MCP screen: the servers the team shares, without their credentials. */
export function Servers({ go, member }: Pick<ViewProps, "go" | "member">) {
  const [round, setRound] = useState(0);
  return (
    <Part
      title="MCP servers"
      intro="Tools for Claude Code, such as Sentry or Linear, that an admin adds for the team, without anyone's keys. Install one to add it to your Claude Code, with your own keys. A change to it waits for your approval again."
    >
      {!member && (
        <div className="mb-4">
          <AddServer added={() => setRound((n) => n + 1)} />
        </div>
      )}
      <Shared
        key={round}
        type="McpServer"
        go={go}
        none={
          <p>{member ? "No server shared yet." : "No server shared yet. Add one from the MCP Registry, or by hand."}</p>
        }
      />
    </Part>
  );
}
