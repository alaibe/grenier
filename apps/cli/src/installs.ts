import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { builtinType, recordProblem, secretIn, sha256 } from "@grenier/core";
import { newId, type StoreDeps, write } from "@grenier/index";
import type { Approval, FullRecord, Store } from "@grenier/store";
import { CommandError, writeAtomically } from "./io.ts";

export type Shared = "Skill" | "McpServer";

const KIND = { Skill: "skill", McpServer: "mcp" } as const;
export const MAX_SKILL_BYTES = 200_000;
export const MAX_SKILL_FILES = 50;
const TOO_BIG = `a shared skill holds at most ${MAX_SKILL_FILES} files and 200 KB`;

export interface SkillFiles {
  name: string;
  description: string;
  files: Record<string, string>;
}

/** A field of SKILL.md's front matter, as `name` or `description`. */
export function skillField(manifest: string, key: string): string | undefined {
  const front = /^---\n([\s\S]*?)\n---/.exec(manifest)?.[1] ?? "";
  return new RegExp(`^${key}:\\s*(.+)$`, "m")
    .exec(front)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
}

/** A skill as a record holds it, SKILL.md and the text files beside it, within a shared skill's limits. */
export function skillFromFiles(files: Record<string, string>, folderName: string): SkillFiles {
  const manifest = files["SKILL.md"];
  if (manifest === undefined) throw new CommandError("a skill has a SKILL.md");
  let bytes = 0;
  for (const [path, text] of Object.entries(files)) {
    if (text.includes("\u0000")) throw new CommandError(`${path} is not a text file; a shared skill holds text only`);
    bytes += Buffer.byteLength(text);
  }
  if (bytes > MAX_SKILL_BYTES || Object.keys(files).length > MAX_SKILL_FILES) throw new CommandError(TOO_BIG);
  const name = skillField(manifest, "name") ?? (folderName || "skill");
  return { name, description: skillField(manifest, "description") ?? "", files };
}

/** A skill's folder as a record holds it: SKILL.md and the text files beside it. */
export function readSkill(dir: string): SkillFiles {
  const manifest = join(dir, "SKILL.md");
  if (!existsSync(manifest)) throw new CommandError(`${dir} has no SKILL.md`);
  const files: Record<string, string> = {};
  let bytes = 0;
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const text = readFileSync(path, "utf8");
      bytes += Buffer.byteLength(text);
      files[relative(dir, path).split(/[\\/]/).join("/")] = text;
      if (bytes > MAX_SKILL_BYTES || Object.keys(files).length > MAX_SKILL_FILES) throw new CommandError(TOO_BIG);
    }
  };
  walk(dir);
  return skillFromFiles(files, dir.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
}

/** What an approval pins: the hash of exactly what gets installed. */
export async function sharedHash(record: Pick<FullRecord, "type" | "fields">): Promise<string> {
  const value =
    record.type === "Skill"
      ? record.fields.files
      : { config: record.fields.config ?? null, credentials: record.fields.credentials ?? [] };
  const entries =
    value && typeof value === "object" ? Object.entries(value).sort(([a], [b]) => a.localeCompare(b)) : [];
  return sha256(JSON.stringify(entries));
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "shared";

export function skillFolder(home: string, record: Pick<FullRecord, "title">): string {
  return join(home, ".claude", "skills", `grenier-${slug(record.title)}`);
}

export function claudeConfig(home: string): string {
  return join(home, ".claude.json");
}

/** A server's entry in Claude Code's config: credentials stay names, read from the person's environment. */
export function serverEntry(record: Pick<FullRecord, "fields">): Record<string, unknown> {
  const config = (record.fields.config ?? {}) as Record<string, unknown>;
  const credentials = Array.isArray(record.fields.credentials) ? (record.fields.credentials as string[]) : [];
  const fromEnvironment = Object.fromEntries(credentials.map((name) => [name, `\${${name}}`]));
  if (typeof config.url === "string") {
    return {
      type: config.type === "sse" ? "sse" : "http",
      url: config.url,
      ...(credentials.length > 0 ? { headers: fromEnvironment } : {}),
    };
  }
  return {
    type: "stdio",
    command: String(config.command ?? ""),
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    ...(credentials.length > 0 ? { env: fromEnvironment } : {}),
  };
}

export function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new CommandError(`${path} is not valid JSON; fix it or move it aside first`);
  }
}

/** A path a skill's file may take inside its folder: relative, without `..`, and `/` its only separator. */
function safePath(path: string): string {
  const normal = posix.normalize(path);
  if (isAbsolute(normal) || normal.startsWith("..") || /[\0\\]/.test(normal) || normal === ".") {
    throw new CommandError(`the skill's file ${path} would land outside its folder`);
  }
  return normal;
}

function writeSkill(folder: string, files: Record<string, string>): void {
  const paths = Object.keys(files).map(safePath);
  rmSync(folder, { recursive: true, force: true });
  for (const [index, path] of paths.entries()) {
    const target = join(folder, path);
    mkdirSync(join(target, ".."), { recursive: true });
    const text = files[Object.keys(files)[index] as string] as string;
    writeFileSync(target, text);
    if (text.startsWith("#!")) chmodSync(target, 0o755);
  }
}

/**
 * Installs a shared skill or server as it is now, and pins its hash: a later change waits for a new approval, unless
 * it is recommended and this machine installs those by itself.
 */
export async function install(
  store: Store,
  home: string,
  record: FullRecord,
  options: { auto?: boolean; files?: Record<string, unknown>; hash?: string } = {},
): Promise<Approval> {
  const kind = KIND[record.type as Shared];
  if (!kind) throw new CommandError(`${record.title} is a ${record.type}, not a skill or an MCP server`);
  const before = await store.approvals.get(record.id, kind);
  const hash = options.hash ?? (await sharedHash(record));
  let installedPath: string;
  if (record.type === "Skill") {
    installedPath = skillFolder(home, record);
    if (existsSync(installedPath) && !before) {
      throw new CommandError(`${installedPath} exists and is not one Grenier installed; move it aside first`);
    }
    writeSkill(installedPath, (options.files ?? record.fields.files ?? {}) as Record<string, string>);
  } else {
    installedPath = claudeConfig(home);
    const config = readJson(installedPath);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    const name = `grenier-${slug(record.title)}`;
    if (servers[name] && !before) {
      throw new CommandError(`Claude Code has a server named ${name} already, not one Grenier installed`);
    }
    servers[name] = serverEntry(record);
    config.mcpServers = servers;
    writeAtomically(installedPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  const approval: Approval = {
    recordId: record.id,
    kind,
    hash,
    approvedAt: Date.now(),
    settings: {
      ...(before?.settings ?? {}),
      auto: options.auto ?? false,
      name: record.type === "Skill" ? slug(record.title) : `grenier-${slug(record.title)}`,
    },
    installedPath,
    previousHash: before && before.hash !== hash ? before.hash : (before?.previousHash ?? null),
  };
  await store.approvals.put(approval);
  return approval;
}

export async function uninstall(store: Store, record: Pick<FullRecord, "id" | "type">): Promise<boolean> {
  const kind = KIND[record.type as Shared];
  const approval = kind ? await store.approvals.get(record.id, kind) : undefined;
  if (!approval) return false;
  if (approval.kind === "skill" && approval.installedPath) {
    rmSync(approval.installedPath, { recursive: true, force: true });
  } else if (approval.installedPath) {
    const config = readJson(approval.installedPath);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    delete servers[String(approval.settings.name ?? "")];
    config.mcpServers = servers;
    writeAtomically(approval.installedPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  await store.approvals.remove(record.id, approval.kind);
  return true;
}

/** Puts back the version installed before the last update, from the record's history on this machine. */
export async function rollback(store: Store, home: string, record: FullRecord): Promise<Approval> {
  const kind = KIND[record.type as Shared];
  const approval = kind ? await store.approvals.get(record.id, kind) : undefined;
  if (!approval?.previousHash) throw new CommandError(`${record.title} has no earlier installed version to go back to`);
  for (const entry of [...(await store.history.list(record.id))].reverse()) {
    const snapshot = entry.snapshot as Pick<FullRecord, "type" | "fields">;
    if ((await sharedHash({ type: record.type, fields: snapshot.fields ?? {} })) !== approval.previousHash) continue;
    const restored = await install(
      store,
      home,
      { ...record, fields: snapshot.fields },
      { hash: approval.previousHash },
    );
    await store.approvals.put({ ...restored, previousHash: null });
    return restored;
  }
  throw new CommandError(`the version installed before is not in this machine's history of ${record.title}`);
}

export interface SharedState {
  id: string;
  type: Shared;
  title: string;
  description: string;
  author: string;
  recommended: boolean;
  /** Installed as it is now, installed with a newer version waiting for approval, or not installed here. */
  state: "installed" | "update" | "available";
  credentials: string[];
  canRollBack: boolean;
}

/** The team's skills and servers, and where this machine stands with each. */
export async function sharedList(store: Store): Promise<SharedState[]> {
  const spaces = (await store.spaces.list()).filter((space) => space.kind !== "me").map((space) => space.id);
  const out: SharedState[] = [];
  for (const type of ["Skill", "McpServer"] as const) {
    for (const record of await store.records.list({ spaces, type })) {
      const approval = await store.approvals.get(record.id, KIND[type]);
      const hash = await sharedHash(record);
      out.push({
        id: record.id,
        type,
        title: record.title,
        description:
          type === "Skill"
            ? (/^description:\s*(.+)$/m.exec(
                String((record.fields.files as Record<string, string>)?.["SKILL.md"] ?? ""),
              )?.[1] ?? "")
            : (record.body.split("\n")[0] ?? ""),
        author: record.author,
        recommended: record.fields.recommended === "yes",
        state: !approval ? "available" : approval.hash === hash ? "installed" : "update",
        credentials: Array.isArray(record.fields.credentials) ? (record.fields.credentials as string[]) : [],
        canRollBack: Boolean(approval?.previousHash),
      });
    }
  }
  return out;
}

/** The record a person names on the command line: its id, or its title in any case. */
export async function findShared(store: Store, type: Shared, name: string): Promise<FullRecord> {
  const byId = await store.records.get(name);
  if (byId?.type === type && byId.retiredAt === null) return byId;
  const spaces = (await store.spaces.list()).map((space) => space.id);
  const found = (await store.records.list({ spaces, type })).filter(
    (record) => record.title.toLowerCase() === name.toLowerCase() || slug(record.title) === slug(name),
  );
  if (found.length === 0) throw new CommandError(`no ${type === "Skill" ? "skill" : "MCP server"} named ${name}`);
  if (found.length > 1) throw new CommandError(`more than one is named ${name}; give its id`);
  return found[0] as FullRecord;
}

/**
 * On a machine that installs recommended ones by itself: each recommended skill or server, installed or brought up
 * to date; those it installed by itself and that were retired since, removed. Returns what it did, to log.
 */
export async function autoInstall(store: Store, home: string): Promise<string[]> {
  if ((await store.state.get("auto_install")) !== "on") return [];
  const done: string[] = [];
  for (const shared of await sharedList(store)) {
    if (!shared.recommended || shared.state === "installed") continue;
    const record = (await store.records.get(shared.id)) as FullRecord;
    try {
      await install(store, home, record, { auto: true });
      done.push(`${shared.state === "update" ? "updated" : "installed"} ${shared.title}`);
    } catch (error) {
      done.push(`could not install ${shared.title}: ${(error as Error).message}`);
    }
  }
  for (const approval of await store.approvals.list()) {
    if (approval.kind !== "skill" && approval.kind !== "mcp") continue;
    const record = await store.records.get(approval.recordId);
    if (approval.settings.auto === true && (!record || record.retiredAt !== null)) {
      await uninstall(store, { id: approval.recordId, type: approval.kind === "skill" ? "Skill" : "McpServer" });
      done.push(`removed ${record?.title ?? approval.recordId}, retired`);
    }
  }
  return done;
}

/** Flags and values that look like they carry a credential, which a shared server's arguments may not. */
const CREDENTIAL_FLAG = /^--?[\w-]*(key|token|secret|password|auth)[\w-]*(=|$)/i;

/** A Claude Code MCP server as the team may share it: its command or URL, and the names of its credentials only. */
export function shareableServer(entry: Record<string, unknown>): {
  config: Record<string, unknown>;
  credentials: string[];
} {
  const credentials = [
    ...Object.keys((entry.env ?? {}) as Record<string, unknown>),
    ...Object.keys((entry.headers ?? {}) as Record<string, unknown>),
  ];
  let config: Record<string, unknown>;
  if (typeof entry.url === "string") {
    const url = new URL(entry.url);
    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) => /key|token|secret|auth/i.test(key))
    ) {
      throw new CommandError("its URL carries a credential; move it to a header first");
    }
    config = { type: entry.type === "sse" ? "sse" : "http", url: entry.url };
  } else {
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    if (args.some((arg) => CREDENTIAL_FLAG.test(arg))) {
      throw new CommandError("its arguments carry a credential; pass it in an environment variable first");
    }
    config = { command: String(entry.command ?? ""), args };
  }
  if (secretIn(JSON.stringify(config)))
    throw new CommandError("its configuration holds what looks like a key or a token");
  return { config, credentials };
}

/** Writes a Skill or McpServer record to the team space, or a new version of the one with the same title. */
export async function share(
  deps: StoreDeps,
  input: { type: Shared; title: string; body: string; fields: Record<string, unknown> },
): Promise<{ id: string; updated: boolean }> {
  const spaces = (await deps.store.spaces.list()).map((space) => space.id);
  if (!spaces.includes("team")) throw new CommandError("this machine is in no team: join one first");
  const existing = (await deps.store.records.list({ spaces: ["team"], type: input.type })).find(
    (record) => slug(record.title) === slug(input.title),
  );
  const why = recordProblem(
    { ...input, fields: { ...(existing?.fields ?? {}), ...input.fields } },
    builtinType(input.type),
  );
  if (why) throw new CommandError(`the team store would refuse it: ${why}`);
  const now = Date.now();
  const record = existing
    ? (({ seq: _seq, hits: _hits, ...rest }) => rest)(existing)
    : {
        id: newId(),
        space: "team",
        type: input.type,
        kind: null,
        author: deps.me.member,
        device: deps.me.device,
        sessionId: null,
        createdAt: now,
        retiredAt: null,
        version: 0,
        anchors: [],
        links: [],
      };
  const next = {
    ...record,
    title: input.title,
    body: input.body,
    fields: { ...(existing?.fields ?? {}), ...input.fields },
    updatedAt: now,
  };
  await write(deps, next, existing);
  return { id: next.id, updated: Boolean(existing) };
}

/** Whether a path is a folder. */
export function isFolder(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
