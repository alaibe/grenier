import { builtinType, recordProblem } from "@grenier/core";
import { check, newRecord, type StoreDeps, write } from "@grenier/index";
import type { FullRecord } from "@grenier/store";

const normal = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Files one Suggestion for each stale, duplicate or broken record and each task for a retired routine. */
export async function librarian(deps: StoreDeps): Promise<{ suggested: number; lines: string[] }> {
  const tops = ["team"];
  const records = await deps.store.records.list({ tops });
  const open = new Set(
    records
      .filter((record) => record.type === "Suggestion")
      .map((record) => `${String(record.fields.target)}:${String(record.fields.reason)}`),
  );
  const found: { target: FullRecord; change: Record<string, unknown>; reason: string }[] = [];

  const seen = new Map<string, FullRecord>();
  for (const record of records) {
    if (record.type === "Suggestion") continue;
    if (record.anchors.some((anchor) => anchor.kind === "git")) {
      const { status, changed } = await check(deps, record);
      if (status === "stale") {
        found.push({
          target: record,
          change: { retire: true },
          reason: `Its files changed since it was written (${changed.join(", ")}): check it again, or retire it.`,
        });
      }
    }
    const key = `${record.top}:${record.type}:${normal(record.title)}`;
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
    const problem = recordProblem(record, builtinType(record.type));
    if (problem) found.push({ target: record, change: {}, reason: `It breaks its type's rules: ${problem}.` });
    if (record.type === "Task" && record.fields.status !== "done" && typeof record.fields.routine === "string") {
      const routine = await deps.store.records.get(record.fields.routine);
      if (!routine || routine.retiredAt !== null) {
        found.push({ target: record, change: { retire: true }, reason: "It is a run of a routine that was retired." });
      }
    }
  }

  const lines: string[] = [];
  let suggested = 0;
  for (const finding of found) {
    if (open.has(`${finding.target.id}:${finding.reason}`)) continue;
    open.add(`${finding.target.id}:${finding.reason}`);
    await write(
      deps,
      newRecord(deps.me, {
        top: finding.target.top,
        type: "Suggestion",
        title: `${finding.target.title}: ${finding.reason.split(":")[0]}`.slice(0, 300),
        folder: "Suggestions",
        fields: { target: finding.target.id, change: finding.change, reason: finding.reason },
        links: [{ kind: "record", ref: finding.target.id }],
      }),
    );
    suggested++;
    lines.push(`${finding.target.title}: ${finding.reason}`);
  }
  return { suggested, lines };
}
