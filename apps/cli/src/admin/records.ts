import { folderProblem, TOPS } from "@grenier/core";
import type { FileVersions, HistoryEntry, PageRow, RecordFull, RecordRow, Top } from "@grenier/core/api";
import { blobText, repoText } from "@grenier/git";
import {
  check,
  type Found,
  newRecord,
  query,
  recall,
  retire,
  type StoreDeps,
  save as saveRecord,
  teamApi,
} from "@grenier/index";
import { type FullRecord, type RecordInput, toInput } from "@grenier/store";
import { Hono } from "hono";
import { z } from "zod";
import { personalKey } from "../runtime.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyAs } from "./request.ts";

/** Records Skills, Routines and Settings manage, which Knowledge's tree leaves out. */
const MANAGED_ELSEWHERE = new Set(["Skill", "McpServer", "Routine", "Task"]);

async function shown(deps: StoreDeps, record: FullRecord, tops: readonly string[]): Promise<RecordFull> {
  const { status, changed } = await check(deps, record);
  const titles = async (ids: readonly string[]) => {
    const out: { id: string; title: string; type: string }[] = [];
    for (const id of ids) {
      const target = await deps.store.records.get(id);
      if (target && tops.includes(target.top)) out.push({ id, title: target.title, type: target.type });
    }
    return out;
  };
  const backlinks = await deps.store.records.list({ tops, linkedTo: { kind: "record", ref: record.id } });
  return {
    ...record,
    status,
    changed,
    linksTo: await titles(record.links.filter((link) => link.kind === "record").map((link) => link.ref)),
    linkedFrom: backlinks.map((other) => ({ id: other.id, title: other.title, type: other.type })),
  };
}

const TopId = z.enum(TOPS);
const Links = z.array(z.object({ kind: z.enum(["record", "repo"]), ref: z.string() }));
const Fields = z.record(z.string(), z.unknown());
const NewPage = z.object({
  top: TopId.default("team"),
  type: z.string().default("Doc"),
  title: z.string().trim().default(""),
  folder: z.string().default(""),
  body: z.string().default(""),
  fields: Fields.default({}),
  links: Links.default([]),
});
const PageEdit = z.object({
  top: TopId.optional(),
  title: z.string().trim().optional(),
  folder: z.string().optional(),
  body: z.string().optional(),
  fields: Fields.optional(),
  links: Links.optional(),
  baseVersion: z.number().int().optional(),
});
const FolderMove = z.object({ top: TopId, from: z.string().min(1), to: z.string().min(1), toTop: TopId.optional() });

/** The editor's records: the tree, search, a record with its links, history and anchors' changes, and every write. */
/** As many records as a list may hold: every one this machine has. */
const ALL = 100_000;

export function recordRoutes(deps: AdminDeps): Hono {
  const { store } = deps;
  const app = new Hono();
  /** The desktop app is the person: it reads every top folder this machine has. */
  const everything = { id: "desktop", name: "desktop", scopes: ["*"] };

  /** Saves through the team store when it can, and syncs at once after: the editor shows what everyone sees. */
  async function save(record: RecordInput, before: FullRecord | undefined, baseVersion: number) {
    const team = deps.team();
    const result = await saveRecord(
      { ...(await deps.storeDeps()), team, personalKey: personalKey(deps.paths) },
      record,
      before,
      baseVersion,
    );
    if (!("saved" in result)) return result;
    if (!result.waiting) {
      await deps.sync().catch(() => undefined);
      return { saved: result.saved };
    }
    return { saved: result.saved, waiting: true, team: Boolean(team) };
  }

  app.get("/tops", async (c) => {
    const stats = await store.records.stats();
    return c.json({
      tops: TOPS.map((id) => ({
        id,
        records: stats.filter((row) => row.top === id).reduce((total, row) => total + row.records, 0),
      })) satisfies Top[],
    });
  });

  /** Knowledge's tree: every page but the records other screens manage. */
  app.get("/pages", async (c) => {
    const records = await store.records.list({ tops: [...TOPS], limit: ALL });
    return c.json({
      pages: records
        .filter((record) => !MANAGED_ELSEWHERE.has(record.type))
        .map(({ id, top, folder, title, type, updatedAt }) => ({
          id,
          top,
          folder,
          title,
          type,
          updatedAt,
        })) satisfies PageRow[],
    });
  });

  /** Moves a folder and every page under it: `to` is the folder's new path, in `toTop` or its own top folder. */
  app.post("/folders/move", async (c) => {
    const { top, from, to, toTop = top } = await bodyAs(c, FolderMove);
    const why = folderProblem(to);
    if (why) return c.json({ error: why }, 400);
    if (toTop === top && (to === from || to.startsWith(`${from}/`))) {
      return c.json({ error: "a folder cannot move into itself" }, 400);
    }
    const inside = (await store.records.list({ tops: [top], limit: ALL })).filter(
      (record) => record.folder === from || record.folder.startsWith(`${from}/`),
    );
    for (const before of inside) {
      const current = toInput(before);
      const folder = `${to}${before.folder.slice(from.length)}`;
      const result = await save({ ...current, top: toTop, folder, updatedAt: Date.now() }, before, before.version);
      if ("conflict" in result) {
        return c.json({ error: `${before.title} changed meanwhile: move the folder again` }, 409);
      }
    }
    return c.json({ moved: inside.length });
  });

  app.get("/records", async (c) => {
    const storeDeps = await deps.storeDeps();
    const { top, type, q: words, retired } = c.req.query();
    const tops = top ? [top] : [...TOPS];
    const filter = { ...(type ? { type } : {}), ...(top ? { top } : {}) };
    const records: Found[] = words?.trim()
      ? (await recall(storeDeps, everything, { query: words.trim(), repo: null, limit: 20, count: false, ...filter }))
          .results
      : (await query(storeDeps, everything, { ...filter, ...(retired === "1" ? { retired: true } : {}), limit: 200 }))
          .records;
    return c.json({ records: records.filter((record) => tops.includes(record.top)) satisfies RecordRow[] });
  });

  app.get("/records/:id", async (c) => {
    const storeDeps = await deps.storeDeps();
    const record = await store.records.get(c.req.param("id"));
    if (!record) return c.json({ error: "no such record" }, 404);
    return c.json(await shown(storeDeps, record, [...TOPS]));
  });

  app.get("/records/:id/history", async (c) => {
    const id = c.req.param("id");
    const team = deps.team();
    // The team store keeps a Me page sealed, so its versions say nothing: this machine's own do.
    if (team && (await store.records.get(id))?.top !== "me") {
      try {
        return c.json(
          await teamApi<{ history: HistoryEntry[] }>(team, `/api/records/${encodeURIComponent(id)}/history`),
        );
      } catch {
        // Offline, or a record that never reached the team store: the versions this machine kept.
      }
    }
    return c.json({ history: (await store.history.list(id)) satisfies HistoryEntry[] });
  });

  /** A stale anchor's file: the version the record was written from, and the one there is now. */
  app.get("/records/:id/diff", async (c) => {
    const file = c.req.query("path") ?? "";
    const record = await store.records.get(c.req.param("id"));
    const anchor = record?.anchors.find((entry) => entry.kind === "git" && entry.ref === file);
    if (!record || !anchor?.repoId) return c.json({ error: "no such file among the record's anchors" }, 404);
    const root = (await store.repos.get(anchor.repoId))?.root;
    if (!root) return c.json({ error: "this repository is not on this machine" }, 404);
    return c.json({
      path: file,
      before: await blobText(root, anchor.version),
      now: await repoText(root, file),
    } satisfies FileVersions);
  });

  app.post("/records", async (c) => {
    const storeDeps = await deps.storeDeps();
    const record = newRecord(storeDeps.me, await bodyAs(c, NewPage));
    const result = await save(record, undefined, 0);
    return c.json({ ...result, id: record.id }, 201);
  });

  app.put("/records/:id", async (c) => {
    const before = await store.records.get(c.req.param("id"));
    if (!before) return c.json({ error: "no such record" }, 404);
    const { baseVersion = before.version, ...body } = await bodyAs(c, PageEdit);
    const current = toInput(before);
    const record: RecordInput = {
      ...current,
      // Only the parts the save names change.
      ...Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)),
      updatedAt: Date.now(),
    };
    const result = await save(record, before, baseVersion);
    return "conflict" in result ? c.json(result, 409) : c.json(result);
  });

  app.delete("/records/:id", async (c) =>
    (await retire(await deps.storeDeps(), c.req.param("id")))
      ? c.json({ retired: c.req.param("id") })
      : c.json({ error: "no such record, or retired already" }, 404),
  );

  return app;
}
