import { builtinType, customType, recordProblem } from "@grenier/core";
import { check, newId, type StoreDeps, write } from "@grenier/index";
import type { FullRecord } from "@grenier/store";

/** The librarian's mark on its routine: a run of it checks the store here instead of starting an agent. */
export const LIBRARIAN = "librarian";

const normal = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Looks through the shared records for what needs a person: memories whose files changed, duplicates, records that
 * break their type's rules, and requests for a retired routine. Each finding becomes a Suggestion a person accepts or
 * dismisses; one already open is not made twice. Returns how many it made.
 */
export async function librarian(deps: StoreDeps): Promise<{ suggested: number; lines: string[] }> {
  const spaces = (await deps.store.spaces.list()).filter((space) => space.kind !== "me").map((space) => space.id);
  const records = await deps.store.records.list({ spaces });
  const types = records.filter((record) => record.type === "Type");
  const open = new Set(
    records
      .filter((record) => record.type === "Suggestion")
      .map((record) => `${String(record.fields.target)}:${String(record.fields.reason)}`),
  );
  const found: { target: FullRecord; change: Record<string, unknown>; reason: string }[] = [];

  const seen = new Map<string, FullRecord>();
  for (const record of records) {
    if (record.type === "Suggestion") continue;
    if (record.type === "Memory" && record.anchors.some((anchor) => anchor.kind === "git")) {
      const { status, changed } = await check(deps, record);
      if (status === "stale") {
        found.push({
          target: record,
          change: { retire: true },
          reason: `Its files changed since it was written (${changed.join(", ")}): check it again, or retire it.`,
        });
      }
    }
    const key = `${record.space}:${record.type}:${normal(record.title)}`;
    const twin = seen.get(key);
    if (twin) {
      const older =
        twin.updatedAt < record.updatedAt || (twin.updatedAt === record.updatedAt && twin.version <= record.version)
          ? twin
          : record;
      const newer = older === twin ? record : twin;
      found.push({
        target: older,
        change: { retire: true },
        reason: `It repeats "${newer.title}" (${newer.id}), which is newer.`,
      });
    } else {
      seen.set(key, record);
    }
    const custom = types.find((type) => type.title === record.type);
    const problem = recordProblem(record, builtinType(record.type) ?? (custom ? customType(custom) : undefined));
    if (problem) found.push({ target: record, change: {}, reason: `It breaks its type's rules: ${problem}.` });
    if (record.type === "Task" && record.fields.status !== "done" && typeof record.fields.routine === "string") {
      const routine = await deps.store.records.get(record.fields.routine);
      if (!routine || routine.retiredAt !== null) {
        found.push({ target: record, change: { retire: true }, reason: "It asks a routine that was retired." });
      }
    }
  }

  const lines: string[] = [];
  let suggested = 0;
  const now = Date.now();
  for (const finding of found) {
    if (open.has(`${finding.target.id}:${finding.reason}`)) continue;
    open.add(`${finding.target.id}:${finding.reason}`);
    await write(deps, {
      id: newId(),
      space: finding.target.space === "me" ? "me" : finding.target.space,
      type: "Suggestion",
      kind: null,
      title: `${finding.target.title}: ${finding.reason.split(":")[0]}`.slice(0, 300),
      body: "",
      fields: { target: finding.target.id, change: finding.change, reason: finding.reason },
      author: deps.me.member,
      device: deps.me.device,
      sessionId: null,
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
      version: 0,
      anchors: [],
      links: [{ kind: "record", ref: finding.target.id }],
    });
    suggested++;
    lines.push(`${finding.target.title}: ${finding.reason}`);
  }
  return { suggested, lines };
}
