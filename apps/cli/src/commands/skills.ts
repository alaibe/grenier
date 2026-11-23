import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { embedderLoader } from "../exploration.ts";
import {
  autoInstall,
  claudeConfig,
  findShared,
  install,
  isFolder,
  readSkill,
  rollback,
  type Shared,
  share,
  shareableServer,
  sharedList,
  uninstall,
} from "../installs.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";
import { storeDeps } from "../runtime.ts";

const STATE = { installed: "installed", update: "update waiting", available: "not installed" } as const;

/**
 * `grenier skills …` and `grenier servers …`: the team's shared skills and MCP servers. Installing one approves it as
 * it is now; a later change waits for the next install, unless it is recommended and `skills auto on` is set.
 */
export async function sharedCommand(type: Shared, argv: string[], io: Io, home: string = homedir()): Promise<string[]> {
  const [action = "list", name, ...rest] = argv;
  const word = type === "Skill" ? "skills" : "servers";
  const { paths, config } = environment(io);
  return withStore(paths, async (store) => {
    switch (action) {
      case "list": {
        const all = (await sharedList(store)).filter((entry) => entry.type === type);
        if (all.length === 0) {
          return [
            type === "Skill"
              ? "The team shares no skill yet. Share one with: grenier skills share <folder>"
              : "The team shares no MCP server yet. Share one with: grenier mcp share <name>",
          ];
        }
        const auto = (await store.state.get("auto_install")) === "on";
        return [
          ...all.map(
            (entry) =>
              `${entry.title.padEnd(28)} ${STATE[entry.state].padEnd(14)} ${entry.recommended ? "recommended  " : ""}by ${entry.author}  ${entry.id}${entry.credentials.length > 0 ? `\n${" ".repeat(29)}needs ${entry.credentials.join(", ")} in your environment` : ""}`,
          ),
          auto
            ? "Recommended ones install and update by themselves here (grenier skills auto off to stop)."
            : "Install one with grenier " +
              `${word} install <id>; grenier skills auto on installs the recommended ones.`,
        ];
      }
      case "install":
      case "remove":
      case "rollback": {
        if (!name || rest.length > 0) throw new UsageError(`${word} ${action} takes one id or name`);
        const record = await findShared(store, type, name);
        if (action === "remove") {
          return (await uninstall(store, record))
            ? [`Removed ${record.title}.`]
            : [`${record.title} is not installed here.`];
        }
        const approval =
          action === "install" ? await install(store, home, record) : await rollback(store, home, record);
        const credentials = Array.isArray(record.fields.credentials) ? (record.fields.credentials as string[]) : [];
        return [
          `${action === "install" ? "Installed" : "Put back the previous version of"} ${record.title} in ${approval.installedPath}.`,
          ...(credentials.length > 0
            ? [`It reads ${credentials.join(", ")} from your environment: set them before starting Claude Code.`]
            : []),
          "Restart Claude Code to load it.",
        ];
      }
      case "share": {
        if (type !== "Skill" || !name || rest.length > 0) {
          throw new UsageError(
            type === "Skill" ? "skills share takes a folder" : "share a server with: grenier mcp share <name>",
          );
        }
        const folder = resolve(io.cwd, name);
        if (!isFolder(folder)) throw new CommandError(`${folder} is not a folder`);
        const skill = readSkill(folder);
        const deps = await storeDeps(store, config, embedderLoader(config, paths, io.err));
        const shared = await share(deps, {
          type: "Skill",
          title: skill.name,
          body: "",
          fields: { files: skill.files },
        });
        return [
          `${shared.updated ? "Shared a new version of" : "Shared"} ${skill.name} with the team (${Object.keys(skill.files).length} files).`,
          "Each teammate installs it with grenier skills install, or by itself where it is recommended.",
        ];
      }
      case "auto": {
        if (type !== "Skill" || (name !== "on" && name !== "off")) throw new UsageError("skills auto takes on or off");
        await store.state.set("auto_install", name);
        if (name === "off") return ["Recommended skills and servers no longer install by themselves here."];
        const done = await autoInstall(store, home);
        return [
          "Recommended skills and servers now install and update by themselves here.",
          ...done.map((line) => `  ${line}`),
        ];
      }
      default:
        throw new UsageError(
          `${word} takes list, install, remove or rollback${type === "Skill" ? ", share or auto" : ""}`,
        );
    }
  });
}

/** `grenier mcp share <name>`: one of the person's Claude Code MCP servers, for the team, without its credentials. */
export async function shareServer(argv: string[], io: Io, home: string = homedir()): Promise<string[]> {
  const [name, ...rest] = argv;
  if (!name || rest.length > 0) throw new UsageError("mcp share takes the name of one of your Claude Code MCP servers");
  const file = claudeConfig(home);
  const servers = existsSync(file)
    ? ((JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> })
        .mcpServers ?? {})
    : {};
  const entry = servers[name];
  if (!entry) throw new CommandError(`Claude Code has no MCP server named ${name} in ${file}`);
  const { config: shared, credentials } = shareableServer(entry);
  const { paths, config } = environment(io);
  return withStore(paths, async (store) => {
    const deps = await storeDeps(store, config, embedderLoader(config, paths, io.err));
    const done = await share(deps, {
      type: "McpServer",
      title: name,
      body: "",
      fields: { config: shared, credentials },
    });
    return [
      `${done.updated ? "Shared a new version of" : "Shared"} ${name} with the team, without its credentials.`,
      ...(credentials.length > 0 ? [`Teammates set ${credentials.join(", ")} in their own environment.`] : []),
    ];
  });
}
