import {
  copiedLines,
  MAX_CODE_LINES,
  MEMBER_WRITES,
  memberMay,
  RECORD_PARTS,
  recordProblem,
  repoTop,
} from "@grenier/core";
import type { FullRecord, Link, RecordInput, Store } from "@grenier/store";
import {
  contentHashes,
  ensureRepoTop,
  inRepo,
  newId,
  type Reader,
  type Repo,
  readable,
  type StoreDeps,
  StoreUseError,
  typeOf,
} from "./records.ts";

export interface RememberInput {
  type?: string;
  kind?: string;
  title: string;
  /** Where it sits in its top folder; a replaced record keeps its own. */
  folder?: string;
  body?: string;
  fields?: Record<string, unknown>;
  /** By default the repository's top folder for what is about its code, else `team` when writable, else `me`. */
  top?: string;
  /** Every file it was worked out from, in the repository the agent is in. */
  files?: readonly string[];
  /** Outside items it came from, as `{ ref: "linear:acme/LIN-123", version: "2026-11-20T10:00:00Z" }`. */
  items?: readonly { ref: string; version: string }[];
  links?: readonly { kind: Link["kind"]; ref: string }[];
  /** Replaces this record instead of adding one. */
  id?: string;
  sessionId?: string;
}

/** A page worked out from the repository's files, and only from them: kept in that repository's folder. */
export function aboutCode(record: { anchors: readonly { kind: FullRecord["anchors"][number]["kind"] }[] }): boolean {
  return record.anchors.length > 0 && record.anchors.every((anchor) => anchor.kind === "git");
}

/** An answer to a question already answered in the same repository replaces that one. */
export async function remember(
  deps: StoreDeps,
  reader: Reader | null,
  repo: Repo | null,
  input: RememberInput,
): Promise<{ id: string; top: string }> {
  const now = (deps.now ?? Date.now)();
  const type = input.type ?? "Memory";
  const kind = type === "Memory" ? (input.kind ?? (input.fields?.kind as string | undefined) ?? "fact") : null;
  const fields: Record<string, unknown> = { ...(input.fields ?? {}), ...(kind ? { kind } : {}) };
  const body = (input.body ?? "").trim();
  const title = input.title.trim();

  const anchors: FullRecord["anchors"] = [];
  if (input.files && input.files.length > 0) {
    if (!repo) throw new StoreUseError("files are anchors in the repository the agent runs in; there is none here");
    const paths = inRepo(deps, repo, input.files);
    const hashes = await contentHashes(deps, repo, paths);
    const missing = paths.filter((path) => !hashes.get(path));
    if (missing.length > 0) throw new StoreUseError(`no such file or directory: ${missing.join(", ")}`);
    await checkCopies(deps, repo, `${title}\n${body}`, paths);
    for (const path of paths)
      anchors.push({ kind: "git", repoId: repo.id, ref: path, version: hashes.get(path) as string });
    if (kind === "summary" && !fields.path) fields.path = paths[0];
  }
  for (const item of input.items ?? []) {
    if (!/^[a-z][\w-]*:\S+$/.test(item.ref))
      throw new StoreUseError(`an item's ref is tool:key, as linear:acme/LIN-123, not ${item.ref}`);
    anchors.push({ kind: "item", repoId: null, ref: item.ref, version: String(item.version) });
  }
  if (type === "Memory" && kind === "answer" && anchors.length === 0) {
    throw new StoreUseError("list the files (or items) the answer was worked out from");
  }

  if (repo) await ensureRepoTop(deps.store, repo);
  const writable = (await readable(deps.store, reader)).map((top) => top.id);
  let top = input.top;
  const member = (await deps.store.state.get("team_role")) === "member";
  if (!top) {
    if (repo && anchors.some((anchor) => anchor.kind === "git")) top = repoTop(repo.id);
    else top = "me";
  }
  if (top !== "me" && !(await deps.store.tops.get(top))) throw new StoreUseError(`there is no top folder ${top}`);
  if (reader && top !== "me" && !writable.includes(top)) throw new StoreUseError(`this client may not write to ${top}`);

  const typeDef = await typeOf(deps.store, type, writable);
  let existing = input.id ? await deps.store.records.get(input.id) : undefined;
  if (input.id && (!existing || (reader && existing.top !== "me" && !writable.includes(existing.top))))
    throw new StoreUseError(`there is no record ${input.id}`);
  // A page about the code with the same title replaces the one before: it is the same question, answered again.
  if (!existing && aboutCode({ anchors })) {
    existing = (await deps.store.records.list({ tops: [top], type })).find(
      (record) => record.title.trim().toLowerCase() === title.toLowerCase(),
    );
  }

  const folder = input.folder ?? existing?.folder ?? "";
  const problem = recordProblem({ type, kind, title, folder, body, fields }, typeDef);
  if (problem) throw new StoreUseError(`the record is refused: ${problem}`);

  const links = [...(input.links ?? [])];
  if (
    repo &&
    !links.some((link) => link.kind === "repo" && link.ref === repo.id) &&
    anchors.some((a) => a.kind === "git")
  ) {
    links.push({ kind: "repo", ref: repo.id });
  }

  // Refused here: the team store would refuse it too.
  if (member && !memberMay(existing, { top, type, title, folder, body, fields }, "me", true)) {
    throw new StoreUseError(`the record is refused: ${MEMBER_WRITES}`);
  }

  const record: RecordInput = {
    id: existing?.id ?? newId(),
    top,
    type,
    kind,
    title,
    folder,
    body,
    fields,
    author: deps.me.member,
    device: deps.me.device,
    sessionId: input.sessionId ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    retiredAt: null,
    version: existing?.version ?? 0,
    anchors,
    links,
  };
  await write(deps, record, existing);
  return { id: record.id, top };
}

/** The parts a change touches: every one for a new record. */
export function changedFields(before: FullRecord | undefined, after: RecordInput): string[] {
  if (!before) return [...RECORD_PARTS];
  return RECORD_PARTS.filter(
    (key) => JSON.stringify((before as unknown as Record<string, unknown>)[key]) !== JSON.stringify(after[key]),
  );
}

/** Why the team store would refuse this change from this machine, or null: its rules, checked before every write. */
export async function refusal(store: Store, record: RecordInput, before?: FullRecord): Promise<string | null> {
  if ((await store.state.get("team_role")) === "member" && !memberMay(before, record, "me", true)) {
    return MEMBER_WRITES;
  }
  const tops = (await store.tops.list()).map((top) => top.id);
  return recordProblem(record, await typeOf(store, record.type, tops));
}

/** The vector a record is found by, when embeddings are on. */
export async function embedding(
  deps: StoreDeps,
  record: { title: string; body: string },
): Promise<{ model: string; vector: Float32Array } | undefined> {
  if (!deps.embedder) return undefined;
  const [vector] = await deps.embedder.embed([`${record.title}\n${record.body}`.slice(0, 2000)]);
  return vector ? { model: deps.embedder.model, vector } : undefined;
}

export async function write(deps: StoreDeps, record: RecordInput, before?: FullRecord): Promise<void> {
  // The team store drops what it refuses: refusing here says so at once, not at the next sync.
  const why = await refusal(deps.store, record, before);
  if (why) throw new StoreUseError(`the record is refused: ${why}`);
  await deps.store.records.put(record, await embedding(deps, record));
  const changed = changedFields(before, record);
  if (changed.length === 0) return;
  await deps.store.outbox.add({
    id: newId(),
    recordId: record.id,
    change: {
      changed,
      record: { ...record, author: deps.me.member, device: deps.me.device },
    },
    baseVersion: before?.version ?? 0,
    createdAt: (deps.now ?? Date.now)(),
  });
}

/** A retired record stays in history, out of recall and query. */
export async function retire(deps: StoreDeps, id: string): Promise<boolean> {
  const record = await deps.store.records.get(id);
  if (!record || record.retiredAt !== null) return false;
  const now = (deps.now ?? Date.now)();
  const { seq: _seq, hits: _hits, ...rest } = record;
  await write(deps, { ...rest, retiredAt: now, updatedAt: now }, record);
  return true;
}

async function checkCopies(deps: StoreDeps, repo: Repo, text: string, paths: readonly string[]) {
  if (!deps.files.text) return;
  for (const path of paths) {
    const source = await deps.files.text(repo.root, path);
    const copied = source === null ? 0 : copiedLines(text, source);
    if (copied > MAX_CODE_LINES) {
      throw new StoreUseError(
        `the record is refused: it copies ${copied} lines of ${path}; describe the code and quote at most ${MAX_CODE_LINES} lines of it`,
      );
    }
  }
}
