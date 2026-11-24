import { folderProblem, repoTop, TEAM_PROTOCOL } from "@grenier/core";
import { blobText, repoText } from "@grenier/git";
import {
  changedFields,
  check,
  embedding,
  type Found,
  newId,
  newRecord,
  query,
  recall,
  refusal,
  retire,
  type StoreDeps,
  StoreUseError,
  TeamError,
  teamApi,
  teamChange,
  write,
} from "@grenier/index";
import type { FullRecord, RecordInput } from "@grenier/store";
import { Hono } from "hono";
import { personalKey } from "../runtime.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf } from "./body.ts";

/** Records Skills, Routines and Settings manage, which Knowledge's tree leaves out. */
const MANAGED_ELSEWHERE = new Set(["Skill", "McpServer", "Routine", "Task", "Type"]);

async function shown(deps: StoreDeps, record: FullRecord, tops: readonly string[]) {
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

/** The editor's records: the tree, search, a record with its links, history and anchors' changes, and every write. */
export function recordRoutes(deps: AdminDeps): Hono {
  const { store } = deps;
  const app = new Hono();
  /** The desktop app is the person: it reads every top folder this machine has. */
  const everything = { id: "desktop", name: "desktop", scopes: ["*"] };
  const allTops = async () => (await store.tops.list()).map((top) => top.id);

  /** With a team, a field changed since `baseVersion` comes back as a conflict; offline, the latest write wins. */
  async function save(record: RecordInput, before: FullRecord | undefined, baseVersion: number) {
    const storeDeps = await deps.storeDeps();
    const why = await refusal(store, record, before);
    if (why) throw new StoreUseError(`the record is refused: ${why}`);
    const team = deps.team();
    // Straight to the team store only once a sync found it speaks this Grenier's protocol; else it waits here.
    const current = Number((await store.state.get("team_protocol")) ?? 0) >= TEAM_PROTOCOL;
    if (team && current && record.top !== "me" && (await store.tops.get(record.top))) {
      const sent = await teamChange(
        { store, personalKey: personalKey(deps.paths) },
        { changed: changedFields(before, record), record: { ...record } },
      );
      try {
        const answer = await teamApi<{
          applied: { version: number }[];
          refused: { reason: string }[];
          conflicts: { current: unknown }[];
        }>(team, "/api/changes", {
          body: { changes: [{ id: newId(), recordId: record.id, baseVersion, ...sent, check: true }] },
        });
        if (answer.conflicts[0]) return { conflict: answer.conflicts[0].current };
        if (answer.refused[0]) throw new StoreUseError(`the team store refused it: ${answer.refused[0].reason}`);
        await store.records.put(
          { ...record, version: answer.applied[0]?.version ?? record.version },
          await embedding(storeDeps, record),
        );
        await deps.sync().catch(() => undefined);
        return { saved: record.id };
      } catch (error) {
        if (error instanceof StoreUseError) throw error;
        if (error instanceof TeamError && error.status < 500) throw new StoreUseError(error.detail);
      }
    }
    await write(storeDeps, record, before);
    return { saved: record.id, waiting: true, team: Boolean(team) };
  }

  app.get("/tops", async (c) => {
    const stats = await store.records.stats();
    return c.json({
      tops: (await store.tops.list()).map((top) => ({
        ...top,
        records: stats.filter((row) => row.top === top.id).reduce((total, row) => total + row.records, 0),
      })),
    });
  });

  /** Knowledge's tree: every page but the records other screens manage. */
  app.get("/pages", async (c) => {
    const records = await store.records.list({ tops: await allTops(), limit: 100_000 });
    return c.json({
      pages: records
        .filter((record) => !MANAGED_ELSEWHERE.has(record.type))
        .map(({ id, top, folder, title, type, updatedAt }) => ({ id, top, folder, title, type, updatedAt })),
    });
  });

  /** Moves a folder and every page under it: `to` is the folder's new path, in `toTop` or its own top folder. */
  app.post("/folders/move", async (c) => {
    const body = await bodyOf(c);
    const top = String(body.top ?? "");
    const from = String(body.from ?? "");
    const to = String(body.to ?? "");
    const toTop = typeof body.toTop === "string" ? body.toTop : top;
    if (from === "" || to === "") return c.json({ error: "a move names the folder and where it goes" }, 400);
    const why = folderProblem(to);
    if (why) return c.json({ error: why }, 400);
    if (toTop === top && (to === from || to.startsWith(`${from}/`))) {
      return c.json({ error: "a folder cannot move into itself" }, 400);
    }
    if (toTop !== "me" && !(await store.tops.get(toTop))) {
      return c.json({ error: `there is no top folder ${toTop}` }, 400);
    }
    const inside = (await store.records.list({ tops: [top], limit: 100_000 })).filter(
      (record) => record.folder === from || record.folder.startsWith(`${from}/`),
    );
    for (const before of inside) {
      const { seq: _seq, hits: _hits, ...current } = before;
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
    const tops = c.req.query("top") ? [c.req.query("top") as string] : await allTops();
    const type = c.req.query("type");
    const words = c.req.query("q")?.trim();
    let records: Found[];
    if (words) {
      records = (
        await recall(storeDeps, everything, {
          query: words,
          repo: null,
          limit: 20,
          count: false,
          ...(type ? { type } : {}),
          ...(c.req.query("top") ? { top: c.req.query("top") as string } : {}),
        })
      ).results;
    } else {
      records = (
        await query(storeDeps, everything, {
          ...(type ? { type } : {}),
          ...(c.req.query("top") ? { top: c.req.query("top") as string } : {}),
          ...(c.req.query("retired") === "1" ? { retired: true } : {}),
          limit: 200,
        })
      ).records;
    }
    return c.json({ records: records.filter((record) => tops.includes(record.top)) });
  });

  app.get("/records/:id", async (c) => {
    const storeDeps = await deps.storeDeps();
    const record = await store.records.get(c.req.param("id"));
    if (!record) return c.json({ error: "no such record" }, 404);
    return c.json(await shown(storeDeps, record, await allTops()));
  });

  app.get("/records/:id/history", async (c) => {
    const id = c.req.param("id");
    const team = deps.team();
    // The team store keeps a Me page sealed, so its versions say nothing: this machine's own do.
    if (team && (await store.records.get(id))?.top !== "me") {
      try {
        return c.json(await teamApi(team, `/api/records/${encodeURIComponent(id)}/history`));
      } catch {
        // Offline, or a record that never reached the team store: the versions this machine kept.
      }
    }
    return c.json({ history: await store.history.list(id) });
  });

  /** A stale anchor's file: the version the record was written from, and the one there is now. */
  app.get("/records/:id/diff", async (c) => {
    const file = c.req.query("path") ?? "";
    const record = await store.records.get(c.req.param("id"));
    const anchor = record?.anchors.find((entry) => entry.kind === "git" && entry.ref === file);
    if (!record || !anchor?.repoId) return c.json({ error: "no such file among the record's anchors" }, 404);
    const root = (await store.tops.get(repoTop(anchor.repoId)))?.root;
    if (!root) return c.json({ error: "this repository is not on this machine" }, 404);
    return c.json({ path: file, before: await blobText(root, anchor.version), now: await repoText(root, file) });
  });

  app.post("/records", async (c) => {
    const storeDeps = await deps.storeDeps();
    const body = (await bodyOf(c)) as Partial<RecordInput>;
    const top = typeof body.top === "string" ? body.top : "team";
    if (top !== "me" && !(await store.tops.get(top))) return c.json({ error: `there is no top folder ${top}` }, 400);
    const record = newRecord(storeDeps.me, {
      top,
      type: typeof body.type === "string" ? body.type : "Doc",
      kind: typeof body.kind === "string" ? body.kind : body.type === "Memory" ? "fact" : null,
      title: String(body.title ?? "").trim(),
      folder: typeof body.folder === "string" ? body.folder : "",
      body: String(body.body ?? ""),
      fields: body.fields && typeof body.fields === "object" ? body.fields : {},
      links: Array.isArray(body.links) ? body.links : [],
    });
    if (record.type === "Memory" && !record.fields.kind) record.fields = { ...record.fields, kind: record.kind };
    const result = await save(record, undefined, 0);
    return c.json({ ...result, id: record.id }, 201);
  });

  app.put("/records/:id", async (c) => {
    const before = await store.records.get(c.req.param("id"));
    if (!before) return c.json({ error: "no such record" }, 404);
    const body = (await bodyOf(c)) as Partial<RecordInput> & { baseVersion?: number };
    const { seq: _seq, hits: _hits, ...current } = before;
    const record: RecordInput = {
      ...current,
      ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
      ...(typeof body.folder === "string" ? { folder: body.folder } : {}),
      ...(typeof body.body === "string" ? { body: body.body } : {}),
      ...(body.fields && typeof body.fields === "object" ? { fields: body.fields } : {}),
      ...(Array.isArray(body.links) ? { links: body.links } : {}),
      ...(typeof body.top === "string" ? { top: body.top } : {}),
      updatedAt: Date.now(),
    };
    if (record.type === "Memory") record.kind = String(record.fields.kind ?? record.kind ?? "fact");
    const result = await save(record, before, typeof body.baseVersion === "number" ? body.baseVersion : before.version);
    return "conflict" in result ? c.json(result, 409) : c.json(result);
  });

  app.delete("/records/:id", async (c) =>
    (await retire(await deps.storeDeps(), c.req.param("id")))
      ? c.json({ retired: c.req.param("id") })
      : c.json({ error: "no such record, or retired already" }, 404),
  );

  return app;
}
