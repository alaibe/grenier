import { homedir } from "node:os";
import { resolve } from "node:path";
import { embedderLoader } from "../exploration.ts";
import { claudeConfig, isFolder, readJson, readSkill, share, shareableServer } from "../installs.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";
import { storeDeps } from "../runtime.ts";

/** `grenier skills share <folder>`: a skill for the team; each teammate installs it from the app's Skills screen. */
export async function shareSkill(argv: string[], io: Io): Promise<string[]> {
  const [action, name, ...rest] = argv;
  if (action !== "share" || !name || rest.length > 0) {
    throw new UsageError("skills takes: share <folder>");
  }
  const folder = resolve(io.cwd, name);
  if (!isFolder(folder)) throw new CommandError(`${folder} is not a folder`);
  const skill = readSkill(folder);
  const { paths, config } = environment(io);
  return withStore(paths, async (store) => {
    const deps = await storeDeps(store, config, embedderLoader(config, paths, io.err));
    const shared = await share(deps, { type: "Skill", title: skill.name, body: "", fields: { files: skill.files } });
    return [
      `${shared.updated ? "Shared a new version of" : "Shared"} ${skill.name} with the team (${Object.keys(skill.files).length} files).`,
      "Each teammate installs it from the app's Skills screen, or it installs by itself where it is recommended.",
    ];
  });
}

/** `grenier mcp share <name>`: one of the person's Claude Code MCP servers, for the team, without its credentials. */
export async function shareServer(argv: string[], io: Io, home: string = homedir()): Promise<string[]> {
  const [name, ...rest] = argv;
  if (!name || rest.length > 0) throw new UsageError("mcp share takes the name of one of your Claude Code MCP servers");
  const file = claudeConfig(home);
  const servers = (readJson(file).mcpServers ?? {}) as Record<string, Record<string, unknown>>;
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
