import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { recordProblem, sharedHash } from "@grenier/core";
import type { SharedNow, SharedState } from "@grenier/core/api";
import { newRecord, type StoreDeps, typeOf, write } from "@grenier/index";
import { type Approval, type FullRecord, type Store, toInput } from "@grenier/store";
import { presentAgents, type Where } from "./agents/index.ts";
import { Refusal } from "./io.ts";
import { keysIn, serverEntry } from "./server-config.ts";
import { type SkillFiles, skillField, writeSkill } from "./skill-files.ts";

export type Shared = "Skill" | "McpServer";

const KIND = { Skill: "skill", McpServer: "mcp" } as const;
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "shared";

/** The folder or server name a shared skill or server installs under, in each agent: `grenier-` and its name. */
export const installedName = (record: Pick<FullRecord, "title">) => `grenier-${slug(record.title)}`;

/**
 * Installs a shared skill or server and pins its hash, so a later change waits for approval again. A server's keys
 * are those just entered, else the ones its entry holds already.
 */
export async function install(
  store: Store,
  where: Where,
  record: FullRecord,
  options: { hash?: string; keys?: Record<string, string> } = {},
): Promise<Approval> {
  const kind = KIND[record.type as Shared];
  if (!kind) throw new Refusal(`${record.title} is a ${record.type}, not a skill or an MCP server`);
  const before = await store.approvals.get(record.id, kind);
  const hash = options.hash ?? (await sharedHash(record));
  const agents = presentAgents(where);
  const name = installedName(record);
  if (record.type === "Skill") {
    const folders = agents.map((agent) => join(agent.skillsDir(where), name));
    const theirs = folders.find((folder) => existsSync(folder));
    if (theirs && !before) throw new Refusal(`${theirs} exists and is not one Grenier installed; move it aside first`);
    for (const folder of folders) writeSkill(folder, (record.fields.files ?? {}) as Record<string, string>);
  } else {
    const found = agents.map((agent) => [agent, agent.servers(where)[name]] as const);
    const theirs = found.find(([, entry]) => entry);
    if (theirs && !before) {
      throw new Refusal(`${theirs[0].label} has a server named ${name} already, not one Grenier installed`);
    }
    const kept = keysIn(record, theirs?.[1]);
    const entry = serverEntry(record, { ...kept, ...(options.keys ?? {}) });
    for (const agent of agents) {
      agent.editServers(where, (servers) => {
        servers[name] = entry;
      });
    }
  }
  const approval: Approval = {
    recordId: record.id,
    kind,
    hash,
    approvedAt: Date.now(),
    settings: { ...(before?.settings ?? {}), name },
    installedPath: null,
    previousHash: before && before.hash !== hash ? before.hash : (before?.previousHash ?? null),
  };
  await store.approvals.put(approval);
  return approval;
}

/** Takes a shared skill or server off every agent here. */
export async function uninstall(store: Store, where: Where, recordId: string, type: Shared): Promise<boolean> {
  const approval = await store.approvals.get(recordId, KIND[type]);
  if (!approval) return false;
  const name = String(approval.settings.name ?? "");
  for (const agent of presentAgents(where)) {
    if (approval.kind === "skill") rmSync(join(agent.skillsDir(where), name), { recursive: true, force: true });
    else if (agent.servers(where)[name]) {
      agent.editServers(where, (servers) => {
        delete servers[name];
      });
    }
  }
  await store.approvals.remove(recordId, approval.kind);
  return true;
}

/** Puts back the version installed before the last update, from the record's history on this machine. */
export async function rollback(store: Store, where: Where, record: FullRecord): Promise<Approval> {
  const kind = KIND[record.type as Shared];
  const approval = kind ? await store.approvals.get(record.id, kind) : undefined;
  if (!approval?.previousHash) throw new Refusal(`${record.title} has no earlier installed version to go back to`);
  for (const entry of [...(await store.history.list(record.id))].reverse()) {
    const snapshot = entry.snapshot as Pick<FullRecord, "type" | "fields">;
    if ((await sharedHash({ type: record.type, fields: snapshot.fields ?? {} })) !== approval.previousHash) continue;
    const restored = await install(
      store,
      where,
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
export async function removeRetired(store: Store, where: Where): Promise<string[]> {
  const done: string[] = [];
  for (const approval of await store.approvals.list()) {
    if (approval.kind !== "skill" && approval.kind !== "mcp") continue;
    const record = await store.records.get(approval.recordId);
    if (record && record.retiredAt === null) continue;
    await uninstall(store, where, approval.recordId, approval.kind === "skill" ? "Skill" : "McpServer");
    done.push(`removed ${record?.title ?? approval.recordId}, which the team retired`);
  }
  return done;
}

/** A skill shared with the team, from its files: a new version when one of its name is there already. */
export async function shareSkill(deps: StoreDeps, skill: SkillFiles): Promise<SharedNow> {
  const shared = await share(deps, { type: "Skill", title: skill.name, body: "", fields: { files: skill.files } });
  return { ...shared, title: skill.name };
}

/** A server shared with the team, with the names of the keys each person enters. */
export async function shareServer(
  deps: StoreDeps,
  title: string,
  description: string,
  fields: { config: Record<string, unknown>; credentials: string[] },
): Promise<SharedNow> {
  return { ...(await share(deps, { type: "McpServer", title, body: description, fields })), title };
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
    ? { ...toInput(existing), ...parts, updatedAt: Date.now() }
    : newRecord(deps.me, { top: "team", type: input.type, ...parts });
  await write(deps, next, existing);
  return { id: next.id, updated: Boolean(existing) };
}
