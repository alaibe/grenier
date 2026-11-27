import {
  builtinType,
  copiedLines,
  MAX_CODE_LINES,
  MEMBER_WRITES,
  memberMay,
  RECORD_PARTS,
  recordProblem,
  TOPS,
} from "@grenier/core";
import { type FullRecord, type Link, type RecordInput, type Store, toInput } from "@grenier/store";
import {
  contentHashes,
  ensureRepo,
  inRepo,
  newId,
  type Reader,
  type Repo,
  readable,
  type StoreDeps,
  StoreUseError,
} from "./records.ts";

export interface RememberInput {
  type?: string;
  title: string;
  /** Where it sits in its top folder; a replaced record keeps its own. */
  folder?: string;
  body?: string;
  fields?: Record<string, unknown>;
  /** By default the repository's top folder for what is about its code, else `me`. */
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

/** A page worked out from the repository's files, and only from them: kept under that repository's name. */
function aboutCode(record: { anchors: readonly { kind: FullRecord["anchors"][number]["kind"] }[] }): boolean {
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
  const type = input.type ?? "Doc";
  const fields: Record<string, unknown> = { ...(input.fields ?? {}) };
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
  }
  for (const item of input.items ?? []) {
    if (!/^[a-z][\w-]*:\S+$/.test(item.ref))
      throw new StoreUseError(`an item's ref is tool:key, as linear:acme/LIN-123, not ${item.ref}`);
    anchors.push({ kind: "item", repoId: null, ref: item.ref, version: String(item.version) });
  }

  const repoName = repo ? await ensureRepo(deps.store, repo) : null;
  const readableTops = readable(reader);
  const top = input.top ?? "me";
  const member = (await deps.store.state.get("team_role")) === "member";
  if (!(TOPS as readonly string[]).includes(top)) throw new StoreUseError(`there is no top folder ${top}`);
  if (reader && top !== "me" && !readableTops.includes(top))
    throw new StoreUseError(`this client may not write to ${top}`);

  const typeDef = builtinType(type);
  let existing = input.id ? await deps.store.records.get(input.id) : undefined;
  if (input.id && (!existing || (reader && existing.top !== "me" && !readableTops.includes(existing.top))))
    throw new StoreUseError(`there is no record ${input.id}`);
  // A page about the code with the same title replaces the one before: it is the same question, answered again.
  if (!existing && repo && aboutCode({ anchors })) {
    existing = (await deps.store.records.list({ tops: [top], type })).find(
      (record) =>
        record.title.trim().toLowerCase() === title.toLowerCase() &&
        record.anchors.some((anchor) => anchor.repoId === repo.id),
    );
  }

  // A page about a repository's code goes under its name, as Me/grenier.
  const folder = input.folder ?? existing?.folder ?? (repoName && aboutCode({ anchors }) ? repoName : "");
  const problem = recordProblem({ type, title, folder, body, fields }, typeDef);
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
  return recordProblem(record, builtinType(record.type));
}

/** The vector a record is found by, when embeddings are on. */
export async function embedding(
  embedder: StoreDeps["embedder"],
  record: { title: string; body: string },
): Promise<{ model: string; vector: Float32Array } | undefined> {
  if (!embedder) return undefined;
  const [vector] = await embedder.embed([`${record.title}\n${record.body}`.slice(0, 2000)]);
  return vector ? { model: embedder.model, vector } : undefined;
}

export async function write(deps: StoreDeps, record: RecordInput, before?: FullRecord): Promise<void> {
  // The team store drops what it refuses: refusing here says so at once, not at the next sync.
  const why = await refusal(deps.store, record, before);
  if (why) throw new StoreUseError(`the record is refused: ${why}`);
  await deps.store.records.put(record, await embedding(deps.embedder, record));
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
  await write(deps, { ...toInput(record), retiredAt: now, updatedAt: now }, record);
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
