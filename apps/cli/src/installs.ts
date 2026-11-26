import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { recordProblem, secretIn, sharedHash } from "@grenier/core";
import type { SharedState } from "@grenier/core/api";
import { writeAtomically } from "@grenier/core/node";
import { newRecord, type StoreDeps, typeOf, write } from "@grenier/index";
import type { Approval, FullRecord, Store } from "@grenier/store";
import { Refusal } from "./io.ts";

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

/** A field of SKILL.md's front matter, as `name` or `description`, plain or in YAML's quotes. */
export function skillField(manifest: string, key: string): string | undefined {
  const front = /^---\n([\s\S]*?)\n---/.exec(manifest)?.[1] ?? "";
  const value = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim();
  if (value && value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value && value.length > 1 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

/** A skill as a record holds it, SKILL.md and the text files beside it, within a shared skill's limits. */
export function skillFromFiles(files: Record<string, string>, folderName: string): SkillFiles {
  const manifest = files["SKILL.md"];
  if (manifest === undefined) throw new Refusal("a skill has a SKILL.md");
  let bytes = 0;
  for (const [path, text] of Object.entries(files)) {
    if (text.includes("\u0000")) throw new Refusal(`${path} is not a text file; a shared skill holds text only`);
    bytes += Buffer.byteLength(text);
  }
  if (bytes > MAX_SKILL_BYTES || Object.keys(files).length > MAX_SKILL_FILES) throw new Refusal(TOO_BIG);
  const name = skillField(manifest, "name") ?? (folderName || "skill");
  return { name, description: skillField(manifest, "description") ?? "", files };
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

const credentialsOf = (record: Pick<FullRecord, "fields">) =>
  Array.isArray(record.fields.credentials) ? (record.fields.credentials as string[]) : [];

/** A remote server's headers as shared: each value a template, as "Bearer {api_key}", whose names are credentials. */
function headerTemplates(config: Record<string, unknown>, credentials: string[]): Record<string, string> {
  const headers = (config.headers ?? {}) as Record<string, unknown>;
  const templates = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]));
  // A credential no template names is sent as a header of its own name.
  for (const name of credentials) {
    if (!Object.values(templates).some((template) => template.includes(`{${name}}`))) templates[name] = `{${name}}`;
  }
  return templates;
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The keys a person entered, read back from their server's entry in Claude Code's config. */
function keysIn(
  record: Pick<FullRecord, "fields">,
  entry: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!entry) return {};
  const config = (record.fields.config ?? {}) as Record<string, unknown>;
  const keys: Record<string, string> = {};
  if (typeof config.url !== "string") {
    for (const [name, value] of Object.entries((entry.env ?? {}) as Record<string, unknown>))
      keys[name] = String(value);
    return keys;
  }
  const headers = (entry.headers ?? {}) as Record<string, unknown>;
  for (const [header, template] of Object.entries(headerTemplates(config, credentialsOf(record)))) {
    const names = [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
    const pattern = new RegExp(`^${literal(template).replace(/\\\{\w+\\\}/g, "(.*)")}$`);
    const found = pattern.exec(String(headers[header] ?? ""));
    if (!found) continue;
    for (const [index, name] of names.entries()) keys[name] = found[index + 1] as string;
  }
  return keys;
}

/** A server's entry in Claude Code's config, with the keys this person entered: they go nowhere else. */
export function serverEntry(record: Pick<FullRecord, "fields">, keys: Record<string, string>): Record<string, unknown> {
  const config = (record.fields.config ?? {}) as Record<string, unknown>;
  const credentials = credentialsOf(record);
  const missing = credentials.filter((name) => !keys[name]);
  if (missing.length > 0) throw new Refusal(`it needs your ${missing.join(", ")}`);
  if (typeof config.url === "string") {
    const headers = Object.fromEntries(
      Object.entries(headerTemplates(config, credentials)).map(([name, template]) => [
        name,
        template.replace(/\{(\w+)\}/g, (_, key: string) => keys[key] ?? ""),
      ]),
    );
    return {
      type: config.type === "sse" ? "sse" : "http",
      url: config.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  const env = {
    ...((config.env ?? {}) as Record<string, string>),
    ...Object.fromEntries(credentials.map((name) => [name, keys[name] as string])),
  };
  return {
    type: "stdio",
    command: String(config.command ?? ""),
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Refusal(`${path} is not valid JSON; fix it or move it aside first`);
  }
}

/** A path a skill's file may take inside its folder: relative, without `..`, and `/` its only separator. */
export function safePath(path: string): string {
  const normal = posix.normalize(path);
  if (isAbsolute(normal) || normal.startsWith("..") || /[\0\\]/.test(normal) || normal === ".") {
    throw new Refusal(`the skill's file ${path} would land outside its folder`);
  }
  return normal;
}

export function writeSkill(folder: string, files: Record<string, string>): void {
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
 * Installs a shared skill or server and pins its hash, so a later change waits for approval again. A server's keys
 * are those just entered, else the ones its entry holds already.
 */
export async function install(
  store: Store,
  home: string,
  record: FullRecord,
  options: { hash?: string; keys?: Record<string, string> } = {},
): Promise<Approval> {
  const kind = KIND[record.type as Shared];
  if (!kind) throw new Refusal(`${record.title} is a ${record.type}, not a skill or an MCP server`);
  const before = await store.approvals.get(record.id, kind);
  const hash = options.hash ?? (await sharedHash(record));
  let installedPath: string;
  if (record.type === "Skill") {
    installedPath = skillFolder(home, record);
    if (existsSync(installedPath) && !before) {
      throw new Refusal(`${installedPath} exists and is not one Grenier installed; move it aside first`);
    }
    writeSkill(installedPath, (record.fields.files ?? {}) as Record<string, string>);
  } else {
    installedPath = claudeConfig(home);
    const config = readJson(installedPath);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    const name = `grenier-${slug(record.title)}`;
    if (servers[name] && !before) {
      throw new Refusal(`Claude Code has a server named ${name} already, not one Grenier installed`);
    }
    const kept = keysIn(record, servers[name] as Record<string, unknown> | undefined);
    servers[name] = serverEntry(record, { ...kept, ...(options.keys ?? {}) });
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
  if (!approval?.previousHash) throw new Refusal(`${record.title} has no earlier installed version to go back to`);
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
  throw new Refusal(`the version installed before is not in this machine's history of ${record.title}`);
}

/** The team's skills and servers, and where this machine stands with each. */
export async function sharedList(store: Store): Promise<SharedState[]> {
  const tops = (await store.tops.list()).filter((top) => top.kind !== "me").map((top) => top.id);
  const out: SharedState[] = [];
  for (const type of ["Skill", "McpServer"] as const) {
    for (const record of await store.records.list({ tops, type })) {
      const approval = await store.approvals.get(record.id, KIND[type]);
      const hash = await sharedHash(record);
      out.push({
        id: record.id,
        type,
        title: record.title,
        description:
          type === "Skill"
            ? (skillField(String((record.fields.files as Record<string, string>)?.["SKILL.md"] ?? ""), "description") ??
              "")
            : (record.body.split("\n")[0] ?? ""),
        author: record.author,
        state: !approval ? "available" : approval.hash === hash ? "installed" : "update",
        credentials: Array.isArray(record.fields.credentials) ? (record.fields.credentials as string[]) : [],
        canRollBack: Boolean(approval?.previousHash),
      });
    }
  }
  return out;
}

/** Removes the skills and servers installed here that the team retired: no list shows them any more. */
export async function removeRetired(store: Store): Promise<string[]> {
  const done: string[] = [];
  for (const approval of await store.approvals.list()) {
    if (approval.kind !== "skill" && approval.kind !== "mcp") continue;
    const record = await store.records.get(approval.recordId);
    if (record && record.retiredAt === null) continue;
    await uninstall(store, { id: approval.recordId, type: approval.kind === "skill" ? "Skill" : "McpServer" });
    done.push(`removed ${record?.title ?? approval.recordId}, which the team retired`);
  }
  return done;
}

/** Flags and values that look like they carry a credential, which a shared server's arguments may not. */
const CREDENTIAL_FLAG = /^--?[\w-]*(key|token|secret|password|auth)[\w-]*(=|$)/i;

/**
 * A server as an admin adds it from the app: a URL with header templates, or a command with its arguments and fixed
 * environment, plus the names of the keys each person enters. Nothing in it may already be a key.
 */
export function serverToShare(input: { config?: unknown; credentials?: unknown }): {
  config: Record<string, unknown>;
  credentials: string[];
} {
  const given = (input.config ?? {}) as Record<string, unknown>;
  const credentials = Array.isArray(input.credentials) ? input.credentials.map(String) : [];
  if (credentials.some((name) => !/^[\w-]{1,80}$/.test(name))) {
    throw new Refusal("a key's name takes letters, digits, _ and -");
  }
  const strings = (value: unknown) =>
    Object.fromEntries(
      Object.entries((value ?? {}) as Record<string, unknown>).map(([name, text]) => [name, String(text)]),
    );
  let config: Record<string, unknown>;
  if (typeof given.url === "string" && given.url.trim()) {
    let url: URL;
    try {
      url = new URL(given.url.trim());
    } catch (error) {
      throw new Refusal((error as Error).message);
    }
    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) => /key|token|secret|auth/i.test(key))
    ) {
      throw new Refusal("its URL carries a credential; move it to a header first");
    }
    const headers = strings(given.headers);
    config = {
      type: given.type === "sse" ? "sse" : "http",
      url: given.url.trim(),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  } else if (typeof given.command === "string" && given.command.trim()) {
    const args = Array.isArray(given.args) ? given.args.map(String) : [];
    if (args.some((arg) => CREDENTIAL_FLAG.test(arg))) {
      throw new Refusal("its arguments carry a credential; pass it in an environment variable first");
    }
    const env = strings(given.env);
    config = { command: given.command.trim(), args, ...(Object.keys(env).length > 0 ? { env } : {}) };
  } else {
    throw new Refusal("a server has a URL, or a command to run");
  }
  if (secretIn(JSON.stringify(config))) throw new Refusal("its configuration holds what looks like a key or a token");
  return { config, credentials };
}

/** Writes a Skill or McpServer record to the Team folder, or a new version of the one with the same title. */
export async function share(
  deps: StoreDeps,
  input: { type: Shared; title: string; body: string; fields: Record<string, unknown> },
): Promise<{ id: string; updated: boolean }> {
  const tops = (await deps.store.tops.list()).map((top) => top.id);
  if (!tops.includes("team")) throw new Refusal("this machine is in no team: join one first");
  const existing = (await deps.store.records.list({ tops: ["team"], type: input.type })).find(
    (record) => slug(record.title) === slug(input.title),
  );
  const fields = { ...(existing?.fields ?? {}), ...input.fields };
  const why = recordProblem({ ...input, fields }, await typeOf(deps.store, input.type, tops));
  if (why) throw new Refusal(`the team store would refuse it: ${why}`);
  const parts = { title: input.title, body: input.body, fields };
  const next = existing
    ? { ...(({ seq: _seq, hits: _hits, ...rest }) => rest)(existing), ...parts, updatedAt: Date.now() }
    : newRecord(deps.me, { top: "team", type: input.type, ...parts });
  await write(deps, next, existing);
  return { id: next.id, updated: Boolean(existing) };
}
