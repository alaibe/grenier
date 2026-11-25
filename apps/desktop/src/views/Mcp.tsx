import type { FoundServer } from "@grenier/core/api";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { Detail } from "../shell/regions.tsx";
import { Button, Primary } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Field, Input, SearchField, Textarea } from "../ui/field.tsx";
import { useAction } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Page, Section } from "../ui/page.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { Table } from "../ui/table.tsx";
import { Apps } from "./Apps.tsx";
import { Shared } from "./Shared.tsx";

/** What connects agents: the servers the team shares for Claude Code, and the apps here that read Grenier. */
export function Mcp({ item, go, member }: ViewProps) {
  const [round, setRound] = useState(0);
  const close = () => go("mcp");
  const commands = useMemo<Command[]>(
    () =>
      member
        ? []
        : [
            {
              id: "new-server",
              label: "Add an MCP server",
              icon: Plus,
              keys: "n",
              also: ["mod+n"],
              hint: { in: "list", says: "new", order: 20 },
              run: () => go("mcp", "new"),
            },
          ],
    [member, go],
  );
  useCommands(commands);
  return (
    <Detail title="MCP">
      <Page
        title="MCP"
        intro="How agents connect: the tools the team shares for Claude Code, and the apps on this computer that read Grenier."
        primary={
          !member && (
            <Primary keys="n" onClick={() => go("mcp", "new")}>
              Add a server…
            </Primary>
          )
        }
      >
        <Section
          heading
          title="MCP servers"
          description="Tools for Claude Code, such as Sentry or Linear, that an admin adds for the team without anyone's keys. Install one to add it to your Claude Code, with your own keys."
        >
          <Shared
            key={round}
            type="McpServer"
            go={go}
            none={member ? "No server shared yet." : "No server shared yet. Add one from the MCP Registry, or by hand."}
          />
        </Section>
        <Apps />
      </Page>
      {!member && item === "new" && (
        <AddServer
          added={() => {
            setRound((n) => n + 1);
            close();
          }}
          cancel={close}
        />
      )}
    </Detail>
  );
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
function AddServer({ added, cancel }: { added: () => void; cancel: () => void }) {
  const action = useAction(added);
  const search = useAction();
  const [found, setFound] = useState<{ words: string; servers: FoundServer[] } | null>(null);
  const [by, setBy] = useState<"registry" | "hand">("registry");
  const share = (body: Record<string, unknown>) =>
    void action.run(`share:${String(body.title)}`, async () => {
      await api("/installs/server", { body });
      return `Shared ${String(body.title)}: each person installs it, with their own keys`;
    });
  const look = (words: string) =>
    void search.run(
      "search",
      async () => {
        const answer = await api<{ servers: FoundServer[] }>(`/installs/registry?q=${encodeURIComponent(words)}`);
        setFound({ words, servers: answer.servers });
        return undefined;
      },
      "Searching",
    );

  return (
    <Dialog
      wide
      title="Add an MCP server"
      action={by === "registry" ? "Search" : "Share with the team"}
      busy={action.busy !== null || search.busy !== null}
      onCancel={cancel}
      onAction={(form) => {
        if (by === "registry") {
          const words = String(form.get("q") ?? "").trim();
          if (words) look(words);
          return;
        }
        const url = String(form.get("url") ?? "").trim();
        const pairs = templates(String(form.get("pairs") ?? ""));
        const command = lines(String(form.get("command") ?? "").replace(/ +/g, "\n"));
        const plain = lines(String(form.get("keys") ?? "").replace(/,/g, "\n"));
        share({
          title: String(form.get("title") ?? ""),
          description: String(form.get("description") ?? ""),
          config: url
            ? { url, headers: pairs.values }
            : { command: command[0] ?? "", args: command.slice(1), env: pairs.values },
          credentials: [...new Set([...pairs.names, ...plain])],
        });
      }}
    >
      <Segmented
        label="How to add it"
        options={[
          ["registry", "From the MCP Registry"],
          ["hand", "By hand"],
        ]}
        value={by}
        onChange={setBy}
      />
      <Problem error={action.problem ?? search.problem} />
      {by === "registry" ? (
        <>
          <SearchField
            name="q"
            label="Words to search the MCP Registry for"
            placeholder="sentry, linear, postgres…"
            keys="enter"
          />
          <p className="field-help">Only these words go to registry.modelcontextprotocol.io.</p>
          {found?.servers.length === 0 && <p>Nothing Grenier can add as it is matches “{found.words}”.</p>}
          {found && found.servers.length > 0 && (
            <div className="max-h-80 overflow-y-auto">
              <Table
                label="Servers found"
                head={
                  <>
                    <th>Server</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </>
                }
              >
                {found.servers.map((server) => (
                  <tr key={server.name}>
                    <td className="py-1.5 whitespace-normal text-fg">
                      <span className="block font-semibold">{server.title}</span>
                      <span className="block font-mono text-xs text-muted">
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
                    </td>
                    <td className="num">
                      <Button
                        size="sm"
                        icon={Plus}
                        disabled={action.busy !== null}
                        onClick={() =>
                          share({
                            title: server.name.split("/").at(-1) ?? server.title,
                            description: server.description,
                            config: server.config,
                            credentials: server.credentials,
                          })
                        }
                      >
                        Add
                      </Button>
                    </td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
        </>
      ) : (
        <>
          <Field label="Name">
            <Input name="title" mono placeholder="sentry" required />
          </Field>
          <Field label="What it gives agents" help="One line.">
            <Input name="description" placeholder="Sentry's issues and events, read-only." />
          </Field>
          <Field label="URL" help="For a remote server.">
            <Input name="url" type="url" mono placeholder="https://mcp.sentry.dev/mcp" />
          </Field>
          <Field label="Or its command" help="For a local one, with a pinned version.">
            <Input name="command" mono placeholder="npx -y @sentry/mcp-server@1.2.0" />
          </Field>
          <Field
            label="Headers or environment"
            help="One per line: headers for a URL, environment for a command. {name} is a key each person enters."
          >
            <Textarea name="pairs" mono rows={3} placeholder={"Authorization: Bearer {sentry_token}"} />
          </Field>
          <Field label="Other keys" help="Environment variables each person enters, comma-separated.">
            <Input name="keys" mono placeholder="SENTRY_TOKEN, SENTRY_ORG" />
          </Field>
        </>
      )}
    </Dialog>
  );
}
