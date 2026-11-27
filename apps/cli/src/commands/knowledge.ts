import { topName } from "@grenier/core";
import type {
  Created,
  FileVersions,
  HistoryEntry,
  PageRow,
  RecordFull,
  RecordRow,
  Saved,
  Top,
} from "@grenier/core/api";
import { hunks, lineDiff } from "@grenier/core/diff";
import { UsageError } from "../io.ts";
import { editedUnless, type Group, q, table, textFrom, UNCHANGED, when } from "./client.ts";

const path = (row: { top: string; folder: string; title: string }) =>
  [row.top, row.folder, row.title].filter(Boolean).join(" / ");

const saved = (answer: Saved & { id?: string }) =>
  `Saved ${answer.id ?? answer.saved}${answer.waiting && answer.team ? ": it reaches the team at the next sync" : ""}`;

/** A stale file's change, as `+` and `-` lines with three kept ones around each run of them. */
export function shownDiff(before: string, now: string): string {
  const lines = lineDiff(before, now);
  if (!lines) return "the files differ too much to show line by line";
  const mark = { same: " ", gone: "-", new: "+" } as const;
  return hunks(lines)
    .map((line) => (line ? `${mark[line.kind]} ${line.text}` : "…"))
    .join("\n");
}

export const PAGES: Group = {
  summary: "Knowledge's pages: what you, your team and your agents wrote down.",
  commands: {
    list: {
      usage: "list [--top <folder>] [--folder <path>]",
      summary: "List the pages, in a top folder or a folder in it",
      options: { top: { type: "string" }, folder: { type: "string" } },
      call: async ({ admin, flags }) => {
        const { pages } = await admin<{ pages: PageRow[] }>("GET", "/pages");
        const folder = flags.folder as string | undefined;
        return pages
          .filter((page) => !flags.top || page.top === flags.top)
          .filter((page) => !folder || page.folder === folder || page.folder.startsWith(`${folder}/`))
          .sort((x, y) => path(x).localeCompare(path(y)));
      },
      show: (pages: PageRow[]) => table(pages.map((page) => [page.id, path(page)])) || "no pages",
    },
    find: {
      usage: "find <words…> [--top <folder>] [--type <type>]",
      summary: "Search the pages as Knowledge's search does",
      options: { top: { type: "string" }, type: { type: "string" } },
      takes: [1, 99],
      call: async ({ admin, args, flags }) => {
        const query = [`q=${q(args.join(" "))}`];
        if (flags.top) query.push(`top=${q(String(flags.top))}`);
        if (flags.type) query.push(`type=${q(String(flags.type))}`);
        return (await admin<{ records: RecordRow[] }>("GET", `/records?${query.join("&")}`)).records;
      },
      show: (records: RecordRow[]) =>
        table(records.map((record) => [record.id, record.status, path(record)])) || "nothing found",
    },
    show: {
      usage: "show <id>",
      summary: "Print a page: where it is, who wrote it, its text",
      takes: [1, 1],
      call: ({ admin, args }) => admin<RecordFull>("GET", `/records/${q(args[0] as string)}`),
      show: (record: RecordFull) =>
        [
          `# ${record.title}`,
          `${path(record)} · ${record.type} · ${record.author} · ${when(record.updatedAt)}` +
            (record.status === "stale" ? ` · stale: ${record.changed.join(", ")}` : ""),
          "",
          record.body,
        ].join("\n"),
    },
    history: {
      usage: "history <id>",
      summary: "List a page's versions",
      takes: [1, 1],
      call: async ({ admin, args }) =>
        (await admin<{ history: HistoryEntry[] }>("GET", `/records/${q(args[0] as string)}/history`)).history,
      show: (history: HistoryEntry[]) =>
        table(history.map((entry) => [`v${entry.version}`, when(entry.ts), entry.author, entry.device])) ||
        "no versions yet: the team store keeps them",
    },
    diff: {
      usage: "diff <id> <file>",
      summary: "Show how a stale page's file changed since it was written",
      takes: [2, 2],
      call: ({ admin, args }) =>
        admin<FileVersions>("GET", `/records/${q(args[0] as string)}/diff?path=${q(args[1] as string)}`),
      show: (file: FileVersions) => shownDiff(file.before ?? "", file.now ?? ""),
    },
    new: {
      usage: "new <title> [--top <folder>] [--folder <path>] [--body <file>|-]",
      summary: "Write a new page, in Me unless --top names another top folder",
      options: { top: { type: "string" }, folder: { type: "string" }, body: { type: "string" } },
      takes: [1, 1],
      call: ({ admin, args, flags }) =>
        admin<Created>("POST", "/records", {
          type: "Doc",
          title: args[0],
          top: flags.top ?? "me",
          folder: flags.folder ?? "",
          body: typeof flags.body === "string" ? textFrom(flags.body) : "",
        }),
      show: saved,
    },
    edit: {
      usage: "edit <id> [--title <t>] [--folder <path>] [--top <folder>] [--body <file>|-]",
      summary: "Change a page: its text in $EDITOR when nothing else is given",
      options: {
        title: { type: "string" },
        folder: { type: "string" },
        top: { type: "string" },
        body: { type: "string" },
      },
      takes: [1, 1],
      call: async ({ admin, args, flags, io }) => {
        const id = args[0] as string;
        const record = await admin<RecordFull>("GET", `/records/${q(id)}`);
        const body = editedUnless(io, flags, ["title", "folder", "top"], "body", record.body);
        if (body === null) return UNCHANGED;
        return admin<Saved>("PUT", `/records/${q(id)}`, {
          baseVersion: record.version,
          ...(flags.title !== undefined ? { title: flags.title } : {}),
          ...(flags.folder !== undefined ? { folder: flags.folder } : {}),
          ...(flags.top !== undefined ? { top: flags.top } : {}),
          ...(typeof body === "string" ? { body } : {}),
        });
      },
      show: saved,
    },
    decide: {
      usage: "decide <id> accept|dismiss",
      summary: "Answer a librarian's suggestion: accepting one that says so retires its page",
      takes: [2, 2],
      call: ({ admin, args }) => {
        if (args[1] !== "accept" && args[1] !== "dismiss") throw new UsageError("decide takes accept or dismiss");
        return admin("POST", `/records/${q(args[0] as string)}/decide`, { accept: args[1] === "accept" });
      },
      show: () => "Done",
    },
    rm: {
      usage: "rm <id>",
      summary: "Delete a page",
      takes: [1, 1],
      call: ({ admin, args }) => admin("DELETE", `/records/${q(args[0] as string)}`),
      show: () => "Deleted",
    },
  },
};

export const FOLDERS: Group = {
  summary: "Knowledge's folders: Me, Team and each repository's, and the folders in them.",
  commands: {
    list: {
      usage: "list",
      summary: "List the top folders, with how many pages each holds",
      call: async ({ admin }) => (await admin<{ tops: Top[] }>("GET", "/tops")).tops,
      show: (tops: Top[]) => table(tops.map((top) => [topName(top.id), top.records])),
    },
    move: {
      usage: "move <top> <from> <to> [--to-top <top>]",
      summary: "Move a folder and every page under it",
      options: { "to-top": { type: "string" } },
      takes: [3, 3],
      call: ({ admin, args, flags }) =>
        admin<{ moved: number }>("POST", "/folders/move", {
          top: args[0],
          from: args[1],
          to: args[2],
          ...(flags["to-top"] ? { toTop: flags["to-top"] } : {}),
        }),
      show: (answer: { moved: number }) => `Moved ${answer.moved} page${answer.moved === 1 ? "" : "s"}`,
    },
  },
};
