import type { FoundServer } from "@grenier/core/api";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import {
  Actions,
  Button,
  Card,
  Empty,
  Field,
  Input,
  List,
  Notice,
  Page,
  Part,
  Row,
  SearchBox,
  Textarea,
  Toggle,
  useAction,
  useAdding,
} from "../ui.tsx";
import { Apps } from "./Apps.tsx";
import { Shared } from "./Shared.tsx";

/** What connects agents: the servers the team shares for Claude Code, and the apps here that read Grenier. */
export function Mcp({ go, member }: ViewProps) {
  return (
    <Page
      title="MCP"
      intro="How agents connect: the tools the team shares for Claude Code, and the apps on this computer that read Grenier."
    >
      <Servers go={go} member={member} />
      <Apps />
    </Page>
  );
}

/** The servers the team shares, without their credentials. */
function Servers({ go, member }: Pick<ViewProps, "go" | "member">) {
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
  const adding = useAdding("Add a server");
  const [found, setFound] = useState<FoundServer[] | null>(null);
  const [by, setBy] = useState<"registry" | "hand">("registry");
  const share = (body: Record<string, unknown>) =>
    void action
      .run(`share:${String(body.title)}`, async () => {
        await api("/installs/server", { body });
        return { text: `Shared ${String(body.title)}. Each person installs it, with their own keys.` };
      })
      .then((ok) => ok && adding.done());
  if (!adding.open) return adding.button;
  return (
    <Card className="grid gap-3">
      <Notice message={action.message} />
      <Toggle
        label="How to add it"
        options={[
          ["registry", "From the MCP Registry"],
          ["hand", "By hand"],
        ]}
        value={by}
        onChange={setBy}
      />
      {by === "registry" ? (
        <>
          <SearchBox
            label="Words to search the MCP Registry for"
            placeholder="Search registry.modelcontextprotocol.io: only these words are sent"
            busy={action.busy === "search"}
            disabled={action.busy !== null}
            onSearch={(words) =>
              void action.run("search", async () => {
                setFound(
                  (await api<{ servers: FoundServer[] }>(`/installs/registry?q=${encodeURIComponent(words)}`)).servers,
                );
                return undefined;
              })
            }
          />
          {found?.length === 0 && <Empty>Nothing Grenier can add as it is.</Empty>}
          {found && found.length > 0 && (
            <List>
              {found.map((server) => (
                <Row
                  key={server.name}
                  title={server.title}
                  meta={
                    <>
                      {server.name} {server.version}
                      {server.description && <span className="block">{server.description}</span>}
                      {server.credentials.length > 0 && (
                        <span className="block">Each person enters {server.credentials.join(", ")}.</span>
                      )}
                      {server.config.command === "docker" && (
                        <span className="block">Runs in Docker: each person needs it installed.</span>
                      )}
                    </>
                  }
                  actions={
                    <Button
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
                  }
                />
              ))}
            </List>
          )}
          <Actions>
            <Button quiet onClick={adding.done}>
              Close
            </Button>
          </Actions>
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
            <Textarea name="pairs" mono className="min-h-32" placeholder={"Authorization: Bearer {sentry_token}"} />
          </Field>
          <Field>
            Other keys each person enters, as environment variables
            <Input name="keys" placeholder="SENTRY_TOKEN, SENTRY_ORG" />
          </Field>
          <Actions>
            <Button type="submit" disabled={action.busy !== null}>
              Share with the team
            </Button>
            <Button quiet onClick={adding.done}>
              Cancel
            </Button>
          </Actions>
        </form>
      )}
    </Card>
  );
}
