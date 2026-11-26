import type { FoundServer, LocalServer } from "@grenier/core/api";
import { folderName } from "@grenier/core/names";
import { serverName } from "@grenier/core/server-name";
import { Plug, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ViewProps } from "../App.tsx";
import { api } from "../api.ts";
import { type Command, useCommands } from "../shell/commands.tsx";
import { ListDetail } from "../shell/regions.tsx";
import { Button, IconButton } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Empty, Skeleton } from "../ui/empty.tsx";
import { Field, Input, SearchField, Select, Textarea } from "../ui/field.tsx";
import { useAction, useLoad } from "../ui/load.ts";
import { Problem } from "../ui/notice.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { Tag } from "../ui/tag.tsx";
import { Tree, type TreeNode, useFolding } from "../ui/tree.tsx";
import { useListSearch } from "./list-search.tsx";
import { LocalServerView, TeamServerView } from "./ServerDetail.tsx";
import { KeysDialog, teamGroup, useShared } from "./shared-entry.tsx";

const loadLocal = () => api<{ servers: LocalServer[] }>("/servers").then((answer) => answer.servers);
const loadProjects = () => api<{ projects: string[] }>("/servers/projects").then((answer) => answer.projects);

/** Where a new server goes: the person's agents, or the team's. */
type Group = "me" | "team";

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** "Name: value" or "NAME=value" lines, as headers or environment. */
function pairsOf(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.indexOf(line.includes(":") ? ":" : "=");
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return values;
}

/** The {names} in templates: the keys each teammate enters. */
const templateNames = (values: Record<string, string>) => [
  ...new Set(Object.values(values).flatMap((value) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string))),
];

/**
 * An MCP server added from the MCP Registry or by hand: into the person's agents, with their own keys, or shared
 * with the team, where `{name}` marks a key each teammate enters.
 */
function AddServer({ to, added, cancel }: { to: Group; added: (id: string) => void; cancel: () => void }) {
  const action = useAction();
  const search = useAction();
  const projects = useLoad(loadProjects);
  const [found, setFound] = useState<{ words: string; servers: FoundServer[] } | null>(null);
  const [keysFor, setKeysFor] = useState<FoundServer | null>(null);
  const [by, setBy] = useState<"registry" | "hand">("registry");
  const nameOf = (server: FoundServer) => serverName(server.name);

  const share = (body: Record<string, unknown>) =>
    void action.run(`add:${String(body.title)}`, async () => {
      const done = await api<{ id: string }>("/installs/server", { body });
      added(`team:${done.id}`);
      return `Shared ${String(body.title)}: each person installs it, with their own keys`;
    });
  const mine = (path: string, body: Record<string, unknown>) =>
    void action.run(`add:${String(body.name)}`, async () => {
      const done = await api<{ id: string }>(path, { body });
      added(`me:${done.id}`);
      return `Added ${String(body.name)} to your agents: restart them to load the server`;
    });
  const pick = (server: FoundServer) => {
    if (to === "team") {
      share({
        title: nameOf(server),
        description: server.description,
        config: server.config,
        credentials: server.credentials,
      });
    } else if (server.credentials.length > 0) setKeysFor(server);
    else mine("/servers/registry", { name: nameOf(server), config: server.config, credentials: [], keys: {} });
  };

  if (keysFor) {
    return (
      <KeysDialog
        title={`Add ${nameOf(keysFor)}`}
        action="Add the server"
        names={keysFor.credentials}
        busy={action.busy !== null}
        problem={action.problem}
        onCancel={() => setKeysFor(null)}
        onKeys={(keys) =>
          mine("/servers/registry", {
            name: nameOf(keysFor),
            config: keysFor.config,
            credentials: keysFor.credentials,
            keys,
          })
        }
      />
    );
  }

  return (
    <Dialog
      wide
      title={to === "me" ? "Add an MCP server for you" : "Add an MCP server for the team"}
      action={by === "registry" ? "Search" : to === "me" ? "Add the server" : "Share with the team"}
      busy={action.busy !== null || search.busy !== null}
      onCancel={cancel}
      onAction={(form) => {
        if (by === "registry") {
          const words = String(form.get("q") ?? "").trim();
          if (!words) return;
          void search.run("search", async () => {
            const answer = await api<{ servers: FoundServer[] }>(`/installs/registry?q=${encodeURIComponent(words)}`);
            setFound({ words, servers: answer.servers });
            return undefined;
          });
          return;
        }
        const url = String(form.get("url") ?? "").trim();
        const pairs = pairsOf(String(form.get("pairs") ?? ""));
        const command = lines(String(form.get("command") ?? "").replace(/ +/g, "\n"));
        const name = String(form.get("title") ?? "");
        const config = url
          ? { url, headers: pairs }
          : { command: command[0] ?? "", args: command.slice(1), env: pairs };
        if (to === "me") {
          mine("/servers", { name, project: String(form.get("project") ?? ""), ...config });
          return;
        }
        const plain = lines(String(form.get("keys") ?? "").replace(/,/g, "\n"));
        share({
          title: name,
          description: String(form.get("description") ?? ""),
          config,
          credentials: [...new Set([...templateNames(pairs), ...plain])],
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
            <ul className="grid max-h-80 overflow-y-auto border-y border-line">
              {found.servers.map((server) => (
                <li key={server.name} className="flex items-center gap-3 border-b border-line py-2 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{server.title}</p>
                    <p className="truncate font-mono text-xs text-muted">
                      {server.name} {server.version}
                    </p>
                    {server.description && <p className="text-sm text-muted">{server.description}</p>}
                    {server.credentials.length > 0 && (
                      <p className="text-sm text-muted">
                        {to === "me" ? "Asks your" : "Each person enters"} {server.credentials.join(", ")}.
                      </p>
                    )}
                    {server.config.command === "docker" && (
                      <p className="text-sm text-muted">Runs in Docker, which needs to be installed.</p>
                    )}
                  </div>
                  <Button size="sm" icon={Plus} disabled={action.busy !== null} onClick={() => pick(server)}>
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <Field label="Name">
            <Input name="title" mono placeholder="sentry" required />
          </Field>
          {to === "me" ? (
            <Field label="For" help="Every project, for Claude Code and Codex, or one project Claude Code knows.">
              <Select name="project" defaultValue="">
                <option value="">Every project</option>
                {(projects.data ?? []).map((project) => (
                  <option key={project} value={project}>
                    {project}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="What it gives agents" help="One line.">
              <Input name="description" placeholder="Sentry's issues and events, read-only." />
            </Field>
          )}
          <Field label="URL" help="For a remote server.">
            <Input name="url" type="url" mono placeholder="https://mcp.sentry.dev/mcp" />
          </Field>
          <Field label="Or its command" help="For a local one, with a pinned version.">
            <Input name="command" mono placeholder="npx -y @sentry/mcp-server@1.2.0" />
          </Field>
          <Field
            label="Headers or environment"
            help={
              to === "me"
                ? "One per line: headers for a URL, environment for a command. Your values go only into your agents' configs."
                : "One per line: headers for a URL, environment for a command. {name} is a key each person enters."
            }
          >
            <Textarea
              name="pairs"
              mono
              rows={3}
              placeholder={to === "me" ? "SENTRY_TOKEN=…" : "Authorization: Bearer {sentry_token}"}
            />
          </Field>
          {to === "team" && (
            <Field label="Other keys" help="Environment variables each person enters, comma-separated.">
              <Input name="keys" mono placeholder="SENTRY_TOKEN, SENTRY_ORG" />
            </Field>
          )}
        </>
      )}
    </Dialog>
  );
}

/** Folders start open, except each project's. Kept in this window only. */
const closedFirst = (id: string) => id.startsWith("me/") && id.includes("/projects/");

/** The MCP servers this person's agents get, beside the team's: listed, added, changed and installed. */
export function Mcp({ item, go, team, admin }: ViewProps) {
  const local = useLoad(loadLocal);
  const shared = useShared("McpServer", Boolean(team));
  const [open, setOpen] = useFolding(closedFirst);
  const [adding, setAdding] = useState<Group | null>(null);
  const reload = () => {
    local.reload();
    shared.reload();
  };
  const select = useCallback((id: string) => go("mcp", id), [go]);

  const {
    field: searchField,
    words,
    query,
    matches,
  } = useListSearch("mcp.search", "Search the servers", "Search servers");
  const commands = useMemo<Command[]>(
    () => [
      {
        id: "new-server",
        label: "Add an MCP server",
        icon: Plus,
        keys: "n",
        also: ["mod+n"],
        hint: { in: "list", says: "new", order: 20 },
        run: () => setAdding("me"),
      },
    ],
    [],
  );
  useCommands(commands);

  const servers = (local.data ?? []).filter((server) =>
    matches(server.name, server.client, server.where, server.command, server.url),
  );
  const leaf = (server: LocalServer): TreeNode => ({
    id: `me:${server.id}`,
    name: server.name,
    icon: Plug,
    meta: server.grenier ? <Tag>grenier</Tag> : server.scope === "repo" ? <Tag>.mcp.json</Tag> : undefined,
  });
  const clients = [...new Set(servers.map((server) => server.client))];
  const ofClient = (client: string): TreeNode => {
    const mine = servers.filter((server) => server.client === client);
    const by = new Map<string, LocalServer[]>();
    for (const server of mine.filter((entry) => entry.scope !== "user")) {
      by.set(server.where ?? "", [...(by.get(server.where ?? "") ?? []), server]);
    }
    const projects = [...by].map(([where, inside]) => ({
      id: `me/${client}/projects/${where}/`,
      name: folderName(where),
      meta: <span title={where}>{where}</span>,
      children: inside.map(leaf),
    }));
    return {
      id: `me/${client}/`,
      name: client,
      children: [
        ...mine.filter((server) => server.scope === "user").map(leaf),
        ...(projects.length > 0 ? [{ id: `me/${client}/projects`, name: "Projects", children: projects }] : []),
      ],
    };
  };
  const teamRows = (shared.data ?? []).filter((entry) => matches(entry.title, entry.description));
  const adds = (to: Group) => (
    <IconButton label="Add an MCP server" icon={Plus} size="sm" onClick={() => setAdding(to)} />
  );
  const nodes: TreeNode[] = [
    {
      id: "me/",
      name: "Me",
      group: true,
      meta: "your agents",
      actions: adds("me"),
      children: clients.map(ofClient),
    },
    ...(team ? [teamGroup(teamRows, Plug, admin && adds("team"))] : []),
  ];

  const list = (
    <>
      {searchField}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Problem error={local.error ?? shared.error} />
        {local.error ? null : !local.data ? (
          <Skeleton rows={8} />
        ) : (
          <Tree
            label="MCP servers"
            nodes={nodes}
            selected={item ?? null}
            open={query ? () => true : open}
            onSelect={(node) => node.children === undefined && select(node.id)}
            onToggle={setOpen}
            onOpen={(node) => select(node.id)}
          />
        )}
        {query && local.data && servers.length === 0 && teamRows.length === 0 && (
          <Empty boot="no match" match>
            No server holds “{words.trim()}”.
          </Empty>
        )}
      </div>
    </>
  );

  const server = item?.startsWith("me:") ? local.data?.find((entry) => `me:${entry.id}` === item) : undefined;
  const entry = item?.startsWith("team:") ? shared.data?.find((one) => `team:${one.id}` === item) : undefined;
  const detail = server ? (
    <LocalServerView
      key={`${item}:${JSON.stringify(server)}`}
      server={server}
      share={admin}
      changed={reload}
      removed={() => {
        reload();
        go("mcp");
      }}
      settings={() => go("settings", "apps")}
    />
  ) : entry ? (
    <TeamServerView
      key={item}
      entry={entry}
      admin={admin}
      changed={reload}
      removed={() => {
        reload();
        go("mcp");
      }}
    />
  ) : local.error ? null : (
    <Empty boot="pick a server">
      Your servers are the ones your agents get: Claude Code's and its projects', Codex's, and your other apps'.
      {team ? " The team's install here, with your own keys, once you approve them." : ""} Add Grenier's own in
      Settings.
    </Empty>
  );

  return (
    <ListDetail title="MCP" list={list}>
      {detail}
      {adding && (
        <AddServer
          to={adding}
          added={(id) => {
            setAdding(null);
            reload();
            select(id);
          }}
          cancel={() => setAdding(null)}
        />
      )}
    </ListDetail>
  );
}
