import { readFileSync } from "node:fs";
import ICAL from "ical.js";
import { createDAVClient } from "tsdav";
import { ConnectorError, type Pull, type PulledItem, secretFor } from "./source.ts";

function person(value: string | null | undefined, name?: unknown): string | null {
  if (!value) return null;
  const address = value.replace(/^mailto:/i, "");
  return typeof name === "string" && name ? `${name} <${address}>` : address;
}

/** The events of an iCalendar text, one item per event (a recurring series is one item, with its rule). */
export function parseEvents(text: string, keyPrefix = ""): PulledItem[] {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch (error) {
    throw new ConnectorError(`not an iCalendar file: ${(error as Error).message}`);
  }
  return root.getAllSubcomponents("vevent").map((component) => {
    const event = new ICAL.Event(component);
    const start = event.startDate;
    const end = event.endDate;
    const organizer = component.getFirstProperty("organizer");
    const people = [
      person(event.organizer, organizer?.getParameter("cn")),
      ...event.attendees.map((attendee) => person(String(attendee.getFirstValue() ?? ""), attendee.getParameter("cn"))),
    ].filter((entry): entry is string => entry !== null);
    const rule = component.getFirstPropertyValue("rrule");
    const lines = [
      `When: ${start?.toJSDate().toISOString() ?? "?"}${end ? ` to ${end.toJSDate().toISOString()}` : ""}`,
      ...(event.location ? [`Where: ${event.location}`] : []),
      ...(rule ? [`Repeats: ${rule.toString()}`] : []),
      ...(event.description ? ["", event.description] : []),
    ];
    const recurrence = event.recurrenceId ? `@${event.recurrenceId.toString()}` : "";
    return {
      key: `${keyPrefix}${event.uid}${recurrence}`,
      kind: "event" as const,
      title: event.summary || "(no title)",
      body: lines.join("\n"),
      people,
      ts: start ? start.toJSDate().getTime() : 0,
    };
  });
}

/**
 * An iCalendar file or URL. A URL is fetched with the ETag of the last pull, so an unchanged calendar costs one
 * 304; every pull returns the whole calendar, and events no longer in it are removed.
 */
export async function pullIcs(
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<Pull> {
  const previous = (state.keys ?? []) as string[];
  let text: string;
  let etag: string | null = null;
  if (typeof config.url === "string") {
    const response = await fetchImpl(config.url, {
      headers: typeof state.etag === "string" ? { "if-none-match": state.etag } : {},
    });
    if (response.status === 304) return { items: [], removed: [], state };
    if (!response.ok) throw new ConnectorError(`${config.url} answered HTTP ${response.status}`);
    text = await response.text();
    etag = response.headers.get("etag");
  } else if (typeof config.path === "string") {
    text = readFileSync(config.path, "utf8");
  } else {
    throw new ConnectorError("an ics source needs a path or a url");
  }
  const items = parseEvents(text);
  const keys = items.map((item) => item.key);
  return {
    items,
    removed: previous.filter((key) => !keys.includes(key)),
    state: { keys, ...(etag ? { etag } : {}) },
  };
}

/** What the CalDAV connector needs of a client: tsdav's, or a stand-in in tests. */
export interface CalDavClient {
  fetchCalendars(): Promise<{ url: string; displayName?: unknown }[]>;
  fetchCalendarObjects(params: { calendar: { url: string } }): Promise<{ url: string; etag?: string; data?: string }[]>;
}

async function davClient(config: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<CalDavClient> {
  if (typeof config.url !== "string" || typeof config.username !== "string") {
    throw new ConnectorError("a caldav source needs a url and a username");
  }
  const client = await createDAVClient({
    serverUrl: config.url,
    credentials: { username: config.username, password: await secretFor(config, env) },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  return client as unknown as CalDavClient;
}

/**
 * CalDAV calendars (all of them, or those named in `calendars`). Only objects whose etag changed since the last
 * pull are parsed; objects gone from the server are removed.
 */
export async function pullCalDav(
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  options: { client?: CalDavClient; env?: NodeJS.ProcessEnv } = {},
): Promise<Pull> {
  const client = options.client ?? (await davClient(config, options.env ?? process.env));
  const wanted = Array.isArray(config.calendars) ? (config.calendars as string[]) : null;
  const seen = (state.objects ?? {}) as Record<string, { etag: string; keys: string[] }>;
  const objects: Record<string, { etag: string; keys: string[] }> = {};
  const items: PulledItem[] = [];

  for (const calendar of await client.fetchCalendars()) {
    if (wanted && !wanted.includes(String(calendar.displayName ?? ""))) continue;
    for (const object of await client.fetchCalendarObjects({ calendar })) {
      const etag = object.etag ?? "";
      const previous = seen[object.url];
      if (previous && previous.etag === etag && etag) {
        objects[object.url] = previous;
        continue;
      }
      const parsed = object.data ? parseEvents(object.data, `${object.url}#`) : [];
      objects[object.url] = { etag, keys: parsed.map((item) => item.key) };
      items.push(...parsed);
    }
  }

  const removed: string[] = [];
  for (const [url, previous] of Object.entries(seen)) {
    const current = objects[url]?.keys ?? [];
    removed.push(...previous.keys.filter((key) => !current.includes(key)));
  }
  return { items, removed, state: { objects } };
}
