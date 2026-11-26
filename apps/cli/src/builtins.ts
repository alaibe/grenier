import { newRecord, type StoreDeps, write } from "@grenier/index";
import { buildReport, money, mostSpentFirst, type Prices, parseSince } from "@grenier/log";
import { librarian } from "./librarian.ts";

/** What a built-in run without an agent gets: the store, and the prices for what it reports. */
export interface BuiltinContext {
  deps: StoreDeps;
  prices: Prices;
  now: number;
}

export interface Builtin {
  title: string;
  schedule: string;
  /** Runs on each person's machines and writes to their Me, rather than for the team. */
  collector: boolean;
  /** What it does: for one an agent runs, what the agent is asked. */
  prompt: string;
  /** Run here, without an agent: the run's result. */
  run?: (context: BuiltinContext) => Promise<string>;
  /** Only an admin's machine runs it, as it writes for the team. */
  admins?: boolean;
}

/** The week's API cost per project and session, what the cache saved, and paused loops: a page in Me. */
async function costDigest({ deps, prices, now }: BuiltinContext): Promise<string> {
  const rows = await deps.store.usage.list({ since: parseSince("7d", now) });
  const projects = mostSpentFirst(buildReport(rows, "repo", prices));
  const total = projects.reduce((sum, row) => sum + row.cost, 0);
  const saved = projects.reduce((sum, row) => sum + row.saved, 0);
  const paused = (await deps.store.sessions.paused()).length;
  const day = new Date(now).toISOString().slice(0, 10);
  const body = [
    `${money(total)} of API cost over the 7 days to ${day}; the prompt cache saved ${money(saved)}.`,
    "",
    "| Project | Requests | Cost | Saved |",
    "| --- | --- | --- | --- |",
    ...projects.map(
      (row) => `| ${row.key || "untagged"} | ${row.requests} | ${money(row.cost)} | ${money(row.saved)} |`,
    ),
    "",
    paused > 0 ? `${paused} sessions are paused by the loop guard: resume or end them on the Cost screen.` : "",
  ]
    .join("\n")
    .trim();
  await write(
    deps,
    newRecord(deps.me, { top: "me", type: "Doc", title: `Cost, week to ${day}`, folder: "Cost", body }),
  );
  return `Wrote Cost, week to ${day}, in Me: ${money(total)} over ${projects.length} projects.`;
}

/** The routines Grenier ships, each added with one click and approved like any other. */
export const BUILTINS: Record<string, Builtin> = {
  librarian: {
    title: "Librarian",
    schedule: "daily 05:00",
    collector: false,
    admins: true,
    prompt:
      "Looks through the team's folders for answers whose files changed, duplicates, records that break their type's rules and runs of retired routines, and files a Suggestion for each, to accept or dismiss in Knowledge.",
    run: async ({ deps }) => {
      const found = await librarian(deps);
      return found.suggested === 0
        ? "The store is in order: nothing to suggest."
        : `${found.suggested} suggestions, to accept or dismiss in Knowledge:\n${found.lines.join("\n")}`;
    },
  },
  refresher: {
    title: "Answer refresher",
    schedule: "daily 06:00",
    collector: false,
    prompt: [
      "Keep the answers Grenier holds about the code current, so get keeps returning hits.",
      "",
      'For each git repository in the work folder: call get with type "Memory", its folder set to the repository\'s folder name and limit 200. For every answer whose status is stale, read only the files listed in changed, then call set with kind "answer", the same question as title, the corrected answer as body, every file you read as files, and repo set to the repository\'s path. Leave hits and every other record alone.',
      "",
      "End with how many answers you refreshed in each repository.",
    ].join("\n"),
  },
  summaries: {
    title: "Repository summaries",
    schedule: "mon 07:00",
    collector: false,
    prompt: [
      "Give Grenier a short summary of each part of the code, so a question about where something is finds one instead of exploring.",
      "",
      "For each git repository in the work folder, and each of its top-level folders: call get with the folder's path as the question. Unless a summary of it is a hit, read enough of the folder to say what it holds and where its main pieces are, then call set with kind \"summary\", the folder's path as title, two to four lines as body, files set to [its path], and repo set to the repository's path.",
      "",
      "End with the summaries you wrote or rewrote.",
    ].join("\n"),
  },
  keeper: {
    title: "Instructions keeper",
    schedule: "fri 16:00",
    collector: true,
    prompt: [
      "Suggest how each project's CLAUDE.md and AGENTS.md should change, from what the team keeps in Grenier. Never edit those files.",
      "",
      'For each git repository in the work folder: read its CLAUDE.md and AGENTS.md, then call get with the questions they should answer, and with type "Decision" and kind conventions for the project. Where a convention or a decision is missing from them, or they say what has since changed, call set with type "Doc", title "Instructions to update: <repository>", and as body the exact lines to add, change or remove, each with the record it comes from.',
      "",
      "End with the repositories you wrote a page for, or none.",
    ].join("\n"),
  },
  digest: {
    title: "Weekly cost digest",
    schedule: "mon 08:00",
    collector: true,
    prompt:
      "Writes a page in your Me with last week's API cost per project, what the prompt cache saved, and the sessions the loop guard paused, sealed with your key like the rest of Me.",
    run: costDigest,
  },
};

/** The built-in a routine is, if Grenier ships it. */
export function builtinOf(routine: { fields: Record<string, unknown> }): Builtin | undefined {
  return BUILTINS[String(routine.fields.builtin ?? "")];
}
