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
      "For each git repository in the work folder: call get with its folder name as folder and limit 200. For every page whose status is stale, read only the files listed in changed, then call set with the same title, the corrected Markdown, every file you read as files, and repo set to the repository's path. Leave every other page alone.",
      "",
      "End with how many answers you refreshed in each repository.",
    ].join("\n"),
  },
  keeper: {
    title: "Instructions keeper",
    schedule: "fri 16:00",
    collector: true,
    prompt: [
      "Suggest how each project's CLAUDE.md and AGENTS.md should change, from what the team keeps in Grenier. Never edit those files.",
      "",
      'For each git repository in the work folder: read its CLAUDE.md and AGENTS.md, then call get with the questions they should answer, and for the team\'s conventions and decisions about the project. Where one is missing from them, or they say what has since changed, call set with the title "Instructions to update: <repository>" and, as Markdown, the exact lines to add, change or remove, each with the page it comes from.',
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
