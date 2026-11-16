import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPull,
  type CalDavClient,
  type ImapClient,
  parseEvents,
  pullCalDav,
  pullIcs,
  pullImap,
  pullMarkdown,
  readFrontMatter,
  secretFor,
  watchMarkdown,
} from "@grenier/connectors";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ICS = readFileSync(new URL("../../fixtures/calendar/team.ics", import.meta.url), "utf8");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grenier-sources-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("markdown", () => {
  it("reads notes with their front matter, title and date", async () => {
    writeFileSync(
      join(dir, "a.md"),
      "---\ntitle: Plans\ndate: 2026-11-01\npeople:\n  - Marie Curie\n  - 'Pierre'\n---\nBody of a.\n",
    );
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.markdown"), "# Heading B\n\nBody of b.\n");
    writeFileSync(join(dir, "skip.txt"), "not a note");
    mkdirSync(join(dir, ".obsidian"));
    writeFileSync(join(dir, ".obsidian", "c.md"), "hidden");

    const pull = await pullMarkdown({ path: dir }, {});
    expect(pull.items.map((item) => [item.key, item.title, item.people])).toEqual([
      ["a.md", "Plans", ["Marie Curie", "Pierre"]],
      ["sub/b.markdown", "Heading B", []],
    ]);
    expect(pull.items[0]).toMatchObject({ kind: "note", body: "Body of a.", ts: Date.parse("2026-11-01") });
  });

  it("reads again only what changed, and reports what was deleted", async () => {
    writeFileSync(join(dir, "a.md"), "A");
    writeFileSync(join(dir, "b.md"), "B");
    const first = await pullMarkdown({ path: dir }, {});
    expect(first.items).toHaveLength(2);

    const unchanged = await pullMarkdown({ path: dir }, first.state);
    expect(unchanged).toEqual({ items: [], removed: [], state: first.state });

    writeFileSync(join(dir, "a.md"), "A, longer now");
    utimesSync(join(dir, "a.md"), new Date(), new Date(Date.now() + 5_000));
    unlinkSync(join(dir, "b.md"));
    const next = await pullMarkdown({ path: dir }, first.state);
    expect(next.items.map((item) => item.key)).toEqual(["a.md"]);
    expect(next.removed).toEqual(["b.md"]);
  });

  it("refuses a path that is not a folder", async () => {
    await expect(pullMarkdown({ path: join(dir, "nope") }, {})).rejects.toThrow("not a folder");
  });

  it("parses inline people lists and files without front matter", () => {
    expect(readFrontMatter('---\npeople: [Ada, "Grace Hopper"]\n---\nx').people).toEqual(["Ada", "Grace Hopper"]);
    expect(readFrontMatter("no front matter")).toEqual({ people: [], body: "no front matter" });
  });

  it("calls back for a burst of changes a few times at most, not once per file", async () => {
    let calls = 0;
    const watcher = watchMarkdown(
      dir,
      () => {
        calls += 1;
      },
      200,
    );
    try {
      for (let index = 0; index < 20; index++) writeFileSync(join(dir, `note-${index}.md`), String(index));
      for (let waited = 0; calls === 0 && waited < 5_000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(calls).toBeLessThanOrEqual(3);
    } finally {
      watcher.close();
    }
  }, 10_000);
});

describe("iCalendar", () => {
  it("turns events into items with their people, place, rule and time", () => {
    const [review, standup] = parseEvents(ICS);
    expect(review).toMatchObject({
      key: "budget-review@example.org",
      kind: "event",
      title: "Budget review",
      ts: Date.UTC(2026, 10, 20, 10),
      people: ["Marie Curie <marie@example.org>", "Pierre Curie <pierre@example.org>", "ada@example.org"],
    });
    expect(review?.body).toContain("Where: Room 4");
    expect(review?.body).toContain("Go through the Q4 numbers.");
    expect(standup?.body).toContain("Repeats: FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  });

  it("reads a file and removes events that left it", async () => {
    writeFileSync(join(dir, "cal.ics"), ICS);
    const first = await pullIcs({ path: join(dir, "cal.ics") }, {});
    expect(first.items).toHaveLength(2);
    writeFileSync(join(dir, "cal.ics"), ICS.replace(/BEGIN:VEVENT\nUID:standup[\s\S]*?END:VEVENT\n/, ""));
    expect((await pullIcs({ path: join(dir, "cal.ics") }, first.state)).removed).toEqual(["standup@example.org"]);
  });

  it("asks a URL with the last ETag, and keeps everything on 304", async () => {
    const requests: (string | undefined)[] = [];
    const server: Server = createServer((request, response) => {
      requests.push(request.headers["if-none-match"]);
      if (request.headers["if-none-match"] === '"v1"') response.writeHead(304).end();
      else response.writeHead(200, { etag: '"v1"', "content-type": "text/calendar" }).end(ICS);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cal.ics`;
      const first = await pullIcs({ url }, {});
      expect(first.state.etag).toBe('"v1"');
      const second = await pullIcs({ url }, first.state);
      expect(second).toEqual({ items: [], removed: [], state: first.state });
      expect(requests).toEqual([undefined, '"v1"']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses text that is not iCalendar", () => {
    expect(() => parseEvents("hello")).toThrow("not an iCalendar file");
  });
});

describe("CalDAV", () => {
  function stand(objects: { url: string; etag: string; data: string }[]) {
    let parsed = 0;
    const client: CalDavClient = {
      fetchCalendars: async () => [
        { url: "/cal/work/", displayName: "Work" },
        { url: "/cal/home/", displayName: "Home" },
      ],
      fetchCalendarObjects: async ({ calendar }) =>
        calendar.url === "/cal/work/"
          ? objects.map((object) => ({
              ...object,
              get data() {
                parsed += 1;
                return object.data;
              },
            }))
          : [],
    };
    return { client, parsed: () => parsed };
  }

  it("parses only objects whose etag changed, and removes those that are gone", async () => {
    const one = ICS.replace(/BEGIN:VEVENT\nUID:standup[\s\S]*?END:VEVENT\n/, "");
    const two = ICS.replace(/BEGIN:VEVENT\nUID:budget-review[\s\S]*?END:VEVENT\n/, "");
    const first = stand([
      { url: "/cal/work/1.ics", etag: "a", data: one },
      { url: "/cal/work/2.ics", etag: "b", data: two },
    ]);
    const pulled = await pullCalDav({ calendars: ["Work"] }, {}, { client: first.client });
    expect(pulled.items.map((item) => item.key)).toEqual([
      "/cal/work/1.ics#budget-review@example.org",
      "/cal/work/2.ics#standup@example.org",
    ]);

    const second = stand([{ url: "/cal/work/1.ics", etag: "a", data: one }]);
    const next = await pullCalDav({ calendars: ["Work"] }, pulled.state, { client: second.client });
    expect(next.items).toEqual([]);
    expect(second.parsed()).toBe(0);
    expect(next.removed).toEqual(["/cal/work/2.ics#standup@example.org"]);
  });
});

describe("IMAP", () => {
  const message = (uid: number, subject: string) => ({
    uid,
    source: Buffer.from(
      `From: Marie Curie <marie@example.org>\r\nTo: ada@example.org\r\nSubject: ${subject}\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello about ${subject}.\r\n`,
    ),
  });

  function stand(mailbox: { uidValidity: number; messages: ReturnType<typeof message>[] }) {
    const searches: { after: number; since?: Date }[] = [];
    const client: ImapClient = {
      connect: async () => {},
      logout: async () => {},
      open: async () => ({ uidValidity: mailbox.uidValidity, close: () => {} }),
      search: async (criteria) => {
        searches.push(criteria);
        return mailbox.messages.map((m) => m.uid).filter((uid) => uid > criteria.after);
      },
      fetch: async function* (uids) {
        for (const m of mailbox.messages) if (uids.includes(m.uid)) yield m;
      },
    };
    return { client, searches };
  }

  it("fetches messages since a date on the first pull, then only new UIDs, and starts over on a new UIDVALIDITY", async () => {
    const now = Date.UTC(2026, 10, 16);
    const box = { uidValidity: 7, messages: [message(1, "Budget"), message(2, "Lunch")] };
    const first = stand(box);
    const pulled = await pullImap({ since_days: 30 }, {}, { client: first.client, now });
    expect(first.searches[0]).toEqual({ after: 0, since: new Date(now - 30 * 86_400_000) });
    expect(pulled.items.map((item) => [item.key, item.title])).toEqual([
      ["INBOX:7:1", "Budget"],
      ["INBOX:7:2", "Lunch"],
    ]);
    expect(pulled.items[0]).toMatchObject({
      kind: "mail",
      body: "Hello about Budget.",
      people: ["Marie Curie <marie@example.org>", "ada@example.org"],
      ts: Date.UTC(2026, 10, 16, 10),
    });

    box.messages.push(message(3, "Invoice"));
    const second = stand(box);
    const next = await pullImap({}, pulled.state, { client: second.client, now });
    expect(second.searches[0]).toEqual({ after: 2 });
    expect(next.items.map((item) => item.key)).toEqual(["INBOX:7:3"]);

    const reset = stand({ uidValidity: 8, messages: box.messages });
    const after = await pullImap({}, next.state, { client: reset.client, now });
    expect(reset.searches[0]?.after).toBe(0);
    expect(after.items).toHaveLength(3);
  });
});

describe("secrets and applying a pull", () => {
  it("gets a password from a command or an env var, never from the config itself", async () => {
    expect(await secretFor({ password_command: [process.execPath, "-e", "console.log('s3cret')"] })).toBe("s3cret");
    expect(await secretFor({ password_env: "MAIL_PW" }, { MAIL_PW: "from-env" })).toBe("from-env");
    await expect(secretFor({ password_env: "MAIL_PW" }, {})).rejects.toThrow("MAIL_PW is not set");
    await expect(secretFor({ password: "plain" })).rejects.toThrow("no password_command or password_env");
  });

  it("writes new and changed items, skips unchanged ones, removes deleted ones and keeps the state", async () => {
    const store: Store = openSqliteStore(":memory:");
    try {
      await store.sources.add({ id: "s", name: "notes", kind: "markdown", config: { path: dir } });
      const item = (key: string, body: string) => ({ key, kind: "note" as const, title: key, body, people: [], ts: 1 });
      expect(
        await applyPull(store, { id: "s" }, { items: [item("a", "1"), item("b", "2")], removed: [], state: { v: 1 } }),
      ).toEqual({
        added: 2,
        removed: 0,
      });
      expect(
        await applyPull(store, { id: "s" }, { items: [item("a", "1"), item("b", "3")], removed: [], state: {} }),
      ).toEqual({
        added: 1,
        removed: 0,
      });
      expect(await applyPull(store, { id: "s" }, { items: [], removed: ["a"], state: { v: 2 } })).toEqual({
        added: 0,
        removed: 1,
      });
      expect(await store.items.ids("s")).toEqual(["s:b"]);
      expect((await store.sources.get("notes"))?.state).toEqual({ v: 2 });
    } finally {
      await store.close();
    }
  });
});
