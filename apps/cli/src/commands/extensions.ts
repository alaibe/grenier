import type {
  FoundServer,
  FoundSkill,
  LocalServer,
  LocalSkill,
  LocalSkillFull,
  RecordFull,
  ServerChange,
  SharedState,
  ToolUsage,
} from "@grenier/core/api";
import { serverName } from "@grenier/core/server-name";
import { Refusal, UsageError } from "../io.ts";
import {
  type Admin,
  type Command,
  type Context,
  edited,
  firstLine,
  type Group,
  named,
  onOne,
  pairs,
  pick,
  q,
  strings,
  table,
  UNCHANGED,
} from "./client.ts";

type Kind = "Skill" | "McpServer";

const KIND: Record<Kind, string> = { Skill: "skill", McpServer: "MCP server" };

const shared = async (admin: Admin, type: Kind) =>
  (await admin<{ shared: SharedState[] }>("GET", "/installs")).shared.filter((entry) => entry.type === type);

const teamOne = async (admin: Admin, type: Kind, wanted: string) =>
  pick(await shared(admin, type), wanted, `team ${KIND[type]}`, (entry) => entry.title);

const sharedRows = (entries: SharedState[]) =>
  entries.map((entry) => [entry.id, entry.state, entry.title, firstLine(entry.description)]);

/** What the team's skills and servers have in common: install here, take off, roll back, remove from the team. */
function installs(type: Kind): Record<string, Command> {
  const find = (admin: Admin, wanted: string) => teamOne(admin, type, wanted);
  return {
    install: onOne({
      usage: "install <id|name> [--key NAME=value]…",
      summary: `Install a team ${KIND[type]} here, or approve its update`,
      options: { key: { type: "string", multiple: true } },
      find,
      send: (admin, entry, flags) => admin("POST", `/installs/${q(entry.id)}`, { keys: pairs(flags.key) }),
      done: (entry) => `Installed ${entry.title}: restart your agents to load it`,
    }),
    uninstall: onOne({
      usage: "uninstall <id|name>",
      summary: `Take a team ${KIND[type]} off this machine, from every agent`,
      find,
      send: (admin, entry) => admin("DELETE", `/installs/${q(entry.id)}`),
      done: (entry) => `Uninstalled ${entry.title}`,
    }),
    rollback: onOne({
      usage: "rollback <id|name>",
      summary: "Put back the version installed here before",
      find,
      send: (admin, entry) => admin("POST", `/installs/${q(entry.id)}/rollback`),
      done: (entry) => `Rolled ${entry.title} back`,
    }),
    retire: onOne({
      usage: "retire <id|name>",
      summary: `Remove a ${KIND[type]} from the team, for everyone (admins)`,
      find,
      send: (admin, entry) => admin("DELETE", `/records/${q(entry.id)}`),
      done: (entry) => `Removed ${entry.title} from the team`,
    }),
  };
}

const mySkills = async (admin: Admin) => (await admin<{ skills: LocalSkill[] }>("GET", "/skills")).skills;
const mySkill = async (admin: Admin, wanted: string) =>
  pick(await mySkills(admin), wanted, "skill", (skill) => skill.name);

/** One of the person's skills, by `<agent>:<name>` or a name only one agent has; else one of the team's. */
async function anySkill(admin: Admin, wanted: string): Promise<{ mine: LocalSkill } | { team: SharedState }> {
  const mine = named(await mySkills(admin), wanted, (skill) => skill.name);
  if (mine.length > 0) return { mine: await mySkill(admin, wanted) };
  return { team: await teamOne(admin, "Skill", wanted) };
}

/** A new skill's answer: shared with the team, which names it, or written here. */
const skillMade = (verb: string) => (answer: { id: string; title?: string }) =>
  answer.title ? `Shared ${answer.title} with the team` : `${verb} ${answer.id}`;

/** A new server's answer: shared with the team, which names it, or added here. */
const serverAdded = (answer: { id: string; title?: string }) =>
  answer.title
    ? `Shared ${answer.title}: each person installs it, with their own keys`
    : "Added it to your agents: restart them to load the server";

const sharedNow = (answer: Record<string, unknown>) => (answer.updated ? "Updated" : "Shared");

const usageShown = (usage: ToolUsage) =>
  usage.calls === 0
    ? "not used here in the last 30 days"
    : [
        `${usage.calls} calls, ${usage.errors} failed, last ${new Date(usage.lastAt ?? 0).toLocaleString()} (30 days)`,
        ...(usage.tools.length > 1
          ? [
              "",
              table(
                usage.tools.map((tool) => [
                  tool.tool,
                  `${tool.calls} calls`,
                  tool.errors ? `${tool.errors} failed` : "",
                ]),
              ),
            ]
          : []),
        "",
        table(usage.projects.map((project) => [project.project || "no folder", `${project.calls} calls`])),
      ].join("\n");

export const SKILLS: Group = {
  summary: "Skills: yours, each agent's, and the team's.",
  commands: {
    list: {
      usage: "list",
      summary: "List your agents' skills and the team's",
      call: async ({ admin }) => ({
        mine: (await admin<{ skills: LocalSkill[] }>("GET", "/skills")).skills,
        team: await shared(admin, "Skill"),
      }),
      show: ({ mine, team }: { mine: LocalSkill[]; team: SharedState[] }) =>
        [
          "Yours",
          table(mine.map((skill) => [skill.id, skill.kind, firstLine(skill.description)])) || "none",
          ...(team.length > 0 ? ["", "Team", table(sharedRows(team))] : []),
        ].join("\n"),
    },
    show: {
      usage: "show <id|name>",
      summary: "Print a skill's SKILL.md and the files beside it",
      takes: [1, 1],
      call: async ({ admin, args }) => {
        const found = await anySkill(admin, args[0] as string);
        if ("mine" in found) return admin<LocalSkillFull>("GET", `/skills/one?id=${q(found.mine.id)}`);
        const record = await admin<RecordFull>("GET", `/records/${q(found.team.id)}`);
        const files = (record.fields.files ?? {}) as Record<string, string>;
        return {
          id: record.id,
          path: "team",
          manifest: files["SKILL.md"] ?? "",
          files: Object.keys(files).filter((file) => file !== "SKILL.md"),
        };
      },
      show: (skill: { id: string; path: string; manifest: string; files: string[] }) =>
        [`${skill.id} · ${skill.path}`, "", skill.manifest.trimEnd(), ...skill.files.map((file) => `+ ${file}`)].join(
          "\n",
        ),
    },
    usage: {
      usage: "usage <id|name>",
      summary: "How often your agents loaded a skill in the last 30 days, and in which projects",
      takes: [1, 1],
      call: async ({ admin, args }) => {
        const found = await anySkill(admin, args[0] as string);
        const query = "mine" in found ? `skill=${q(found.mine.id)}` : `shared=${q(found.team.id)}`;
        return admin<ToolUsage>("GET", `/usage?${query}`);
      },
      show: usageShown,
    },
    new: {
      usage: "new <name> --description <line> [--instructions <file>|-] [--team]",
      summary: "Write a skill, for every agent here, or for the team",
      options: { description: { type: "string" }, instructions: { type: "string" }, team: { type: "boolean" } },
      takes: [1, 1],
      call: async ({ admin, args, flags, io }) => {
        if (!flags.description) throw new UsageError("a skill needs --description: one line on when to use it");
        const instructions = edited(io, flags.instructions, "", "instructions") ?? "";
        const body = { name: args[0], description: flags.description, instructions };
        return flags.team ? admin("POST", "/installs/skill", body) : admin("POST", "/skills", body);
      },
      show: skillMade("Wrote"),
    },
    find: {
      usage: "find <words…>",
      summary: "Search skills.sh, sending only these words",
      takes: [1, 99],
      call: async ({ admin, args }) =>
        (await admin<{ skills: FoundSkill[] }>("GET", `/installs/search?q=${q(args.join(" "))}`)).skills,
      show: (skills: FoundSkill[]) =>
        table(skills.map((skill) => [skill.source, skill.name, `${skill.installs} installs`])) || "nothing found",
    },
    add: {
      usage: "add <source> <name> [--team]",
      summary: "Add a skill found on skills.sh, for you or the team",
      options: { team: { type: "boolean" } },
      takes: [2, 2],
      call: ({ admin, args, flags }) =>
        admin("POST", flags.team ? "/installs/share" : "/skills/found", {
          source: args[0],
          name: args[1],
        }),
      show: skillMade("Added"),
    },
    edit: {
      usage: "edit <id|name> [--manifest <file>|-]",
      summary: "Change a skill's SKILL.md, yours or, as an admin, the team's",
      options: { manifest: { type: "string" } },
      takes: [1, 1],
      call: async ({ admin, args, flags, io }) => {
        const found = await anySkill(admin, args[0] as string);
        if ("mine" in found) {
          const skill = await admin<LocalSkillFull>("GET", `/skills/one?id=${q(found.mine.id)}`);
          const manifest = edited(io, flags.manifest, skill.manifest, "manifest");
          if (manifest === null) return UNCHANGED;
          await admin("PUT", `/skills/one?id=${q(skill.id)}`, { manifest });
          return { saved: skill.id };
        }
        const record = await admin<RecordFull>("GET", `/records/${q(found.team.id)}`);
        const before = ((record.fields.files ?? {}) as Record<string, string>)["SKILL.md"] ?? "";
        const manifest = edited(io, flags.manifest, before, "manifest");
        if (manifest === null) return UNCHANGED;
        await admin("PUT", `/installs/${q(record.id)}/skill`, { manifest });
        return { saved: record.title, team: true };
      },
      show: (answer: { saved: string; team?: boolean }) =>
        answer.team ? `Saved ${answer.saved}: each machine approves the new version` : `Saved ${answer.saved}`,
    },
    rm: onOne({
      usage: "rm <id|name>",
      summary: "Delete one of your skills, or a link to one",
      find: mySkill,
      send: (admin, skill) => admin("DELETE", `/skills/one?id=${q(skill.id)}`),
      done: (skill) => `Removed ${skill.id}`,
    }),
    share: onOne({
      usage: "share <id|name>",
      summary: "Share one of your skills with the team (admins)",
      find: mySkill,
      send: (admin, skill) => admin("POST", `/skills/share?id=${q(skill.id)}`),
      done: (skill, answer) => `${sharedNow(answer)} ${skill.name} with the team`,
    }),
    ...installs("Skill"),
  },
};

const myServers = async (admin: Admin, flags?: Context["flags"]) => {
  const app = flags?.app ? String(flags.app).toLowerCase() : null;
  return (await admin<{ servers: LocalServer[] }>("GET", "/servers")).servers.filter(
    (server) => !app || server.client.toLowerCase() === app || server.app === app,
  );
};

const myServer = async (admin: Admin, wanted: string, flags?: Context["flags"]) =>
  pick(await myServers(admin, flags), wanted, "server", (server) => server.name);

/** One of the person's servers by name, else one of the team's. */
async function anyServer(
  admin: Admin,
  wanted: string,
  flags: Context["flags"],
): Promise<{ mine: LocalServer } | { team: SharedState }> {
  const mine = await myServers(admin, flags);
  if (named(mine, wanted, (server) => server.name).length > 0) {
    return { mine: pick(mine, wanted, "server", (server) => server.name) };
  }
  return { team: await teamOne(admin, "McpServer", wanted) };
}

const reach = (server: LocalServer) => server.url ?? [server.command, ...server.args].filter(Boolean).join(" ");

/** A server's config from the command line: a URL with its headers, or a command with its arguments and env. */
function configOf(flags: Record<string, unknown>, args: string[]) {
  if (flags.url) return { url: flags.url, headers: pairs(flags.header) };
  if (!flags.command)
    throw new UsageError("a server takes --url <url>, or --command <program> and its arguments after --");
  return { command: flags.command, args, env: pairs(flags.env) };
}

export const SERVERS: Group = {
  summary: "MCP servers: each app's, each Claude Code project's, and the team's.",
  commands: {
    list: {
      usage: "list",
      summary: "List the servers your agents get, and the team's",
      call: async ({ admin }) => ({
        mine: (await admin<{ servers: LocalServer[] }>("GET", "/servers")).servers,
        team: await shared(admin, "McpServer"),
      }),
      show: ({ mine, team }: { mine: LocalServer[]; team: SharedState[] }) =>
        [
          "Yours",
          table(
            mine.map((server) => [
              server.name,
              server.client,
              server.scope === "user" ? "every project" : `${server.scope} ${server.where}`,
              server.editable ? "" : "read-only",
              reach(server),
            ]),
          ) || "none",
          ...(team.length > 0 ? ["", "Team", table(sharedRows(team))] : []),
        ].join("\n"),
    },
    show: {
      usage: "show <id|name> [--app <app>]",
      summary: "Print a server: how it runs, and the names of its keys",
      options: { app: { type: "string" } },
      takes: [1, 1],
      call: ({ admin, args, flags }) => myServer(admin, args[0] as string, flags),
      show: (server: LocalServer) =>
        table([
          ["name", server.name],
          ["app", server.client],
          ["for", server.scope === "user" ? "every project" : `${server.where} (${server.scope})`],
          ["runs", `${server.transport}: ${reach(server)}`],
          ["env", server.env.join(", ")],
          ["headers", server.headers.join(", ")],
          ["id", server.id],
        ]),
    },
    usage: {
      usage: "usage <id|name> [--app <app>]",
      summary: "How often your agents called a server's tools in the last 30 days, by tool and project",
      options: { app: { type: "string" } },
      takes: [1, 1],
      call: async ({ admin, args, flags }) => {
        const found = await anyServer(admin, args[0] as string, flags);
        const query = "mine" in found ? `server=${q(found.mine.id)}` : `shared=${q(found.team.id)}`;
        return admin<ToolUsage>("GET", `/usage?${query}`);
      },
      show: usageShown,
    },
    projects: {
      usage: "projects",
      summary: "List the projects Claude Code knows, which add --project takes",
      call: async ({ admin }) => (await admin<{ projects: string[] }>("GET", "/servers/projects")).projects,
      show: (projects: string[]) => projects.join("\n") || "no projects",
    },
    find: {
      usage: "find <words…>",
      summary: "Search the MCP Registry, sending only these words",
      takes: [1, 99],
      call: async ({ admin, args }) =>
        (await admin<{ servers: FoundServer[] }>("GET", `/installs/registry?q=${q(args.join(" "))}`)).servers,
      show: (servers: FoundServer[]) =>
        table(
          servers.map((server) => [
            server.name,
            server.credentials.length > 0 ? `needs ${server.credentials.join(", ")}` : "",
            firstLine(server.description),
          ]),
        ) || "nothing found",
    },
    add: {
      usage:
        "add <name> (--url <url> [--header K=V]… | --command <program> [--env K=V]… [-- <args…>]) [--project <folder>] [--team [--key NAME]…]",
      summary: "Add a server by hand: for every agent, one Claude Code project, or the team",
      options: {
        url: { type: "string" },
        header: { type: "string", multiple: true },
        command: { type: "string" },
        env: { type: "string", multiple: true },
        project: { type: "string" },
        team: { type: "boolean" },
        key: { type: "string", multiple: true },
        description: { type: "string" },
      },
      takes: [1, 99],
      call: ({ admin, args, flags }) => {
        const [name, ...rest] = args;
        const config = configOf(flags, rest);
        if (flags.team) {
          const templates = Object.values({ ...(config.headers ?? {}), ...(config.env ?? {}) }).flatMap((value) =>
            [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string),
          );
          return admin("POST", "/installs/server", {
            title: name,
            description: flags.description ?? "",
            config,
            credentials: [...new Set([...templates, ...strings(flags.key)])],
          });
        }
        return admin("POST", "/servers", { name, project: flags.project ?? "", ...config });
      },
      show: serverAdded,
    },
    "add-registry": {
      usage: "add-registry <registry name> [--name <name>] [--key NAME=value]… [--team]",
      summary: "Add a server found in the MCP Registry, with the keys it asks for",
      options: { name: { type: "string" }, key: { type: "string", multiple: true }, team: { type: "boolean" } },
      takes: [1, 1],
      call: async ({ admin, args, flags }) => {
        const wanted = args[0] as string;
        const found = (await admin<{ servers: FoundServer[] }>("GET", `/installs/registry?q=${q(wanted)}`)).servers;
        const server = found.find((entry) => entry.name === wanted);
        if (!server) throw new Refusal(`the MCP Registry has no ${wanted}: find takes words to look for`);
        const name = (flags.name as string | undefined) ?? serverName(server.name);
        if (flags.team) {
          return admin("POST", "/installs/server", {
            title: name,
            description: server.description,
            config: server.config,
            credentials: server.credentials,
          });
        }
        const keys = pairs(flags.key);
        const missing = server.credentials.filter((key) => !keys[key]);
        if (missing.length > 0)
          throw new UsageError(`${name} needs ${missing.map((key) => `--key ${key}=…`).join(" ")}`);
        return admin("POST", "/servers/registry", {
          name,
          config: server.config,
          credentials: server.credentials,
          keys,
        });
      },
      show: serverAdded,
    },
    edit: {
      usage:
        "edit <id|name> [--app <app>] [--command <program>] [--url <url>] [--env K=V|K=]… [--header K=V|K=]… [-- <args…>]",
      summary: "Change one of your servers; K= removes a value, and arguments after -- replace its own",
      options: {
        app: { type: "string" },
        command: { type: "string" },
        url: { type: "string" },
        env: { type: "string", multiple: true },
        header: { type: "string", multiple: true },
      },
      takes: [1, 99],
      call: async ({ admin, args, flags }) => {
        const [wanted, ...rest] = args;
        const server = await myServer(admin, wanted as string, flags);
        const change: ServerChange = {
          ...(typeof flags.command === "string" ? { command: flags.command } : {}),
          ...(typeof flags.url === "string" ? { url: flags.url } : {}),
          ...(rest.length > 0 ? { args: rest } : {}),
          ...(flags.env ? { env: pairs(flags.env, true) } : {}),
          ...(flags.header ? { headers: pairs(flags.header, true) } : {}),
        };
        if (Object.keys(change).length === 0) throw new UsageError("edit takes what to change");
        await admin("PUT", `/servers/one?id=${q(server.id)}`, change);
        return { saved: server.name, app: server.client };
      },
      show: (answer: { saved: string; app: string }) => `Saved ${answer.saved}: restart ${answer.app} to load it`,
    },
    rm: onOne({
      usage: "rm <id|name> [--app <app>]",
      summary: "Remove one of your servers",
      options: { app: { type: "string" } },
      find: myServer,
      send: (admin, server) => admin("DELETE", `/servers/one?id=${q(server.id)}`),
      done: (server) => `Removed ${server.name} from ${server.client}`,
    }),
    share: onOne({
      usage: "share <id|name> [--app <app>]",
      summary: "Share one of your servers with the team, its values left out (admins)",
      options: { app: { type: "string" } },
      find: myServer,
      send: (admin, server) => admin("POST", `/servers/share?id=${q(server.id)}`),
      done: (server, answer) => `${sharedNow(answer)} ${server.name}: each person installs it, with their own keys`,
    }),
    ...installs("McpServer"),
  },
};
