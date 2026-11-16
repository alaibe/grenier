import { ImapFlow } from "imapflow";
import { type AddressObject, simpleParser } from "mailparser";
import { ConnectorError, type Pull, type PulledItem, secretFor } from "./source.ts";

const MAX_BODY = 20_000;
const DAY = 86_400_000;

/** What the IMAP connector needs of a client: imapflow's, or a stand-in in tests. */
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  /** Opens a mailbox; returns its UIDVALIDITY. */
  open(mailbox: string): Promise<{ uidValidity: number; close: () => void }>;
  /** The UIDs above `after`, and since a date for a first pull. */
  search(criteria: { after: number; since?: Date }): Promise<number[]>;
  /** The raw message (RFC 5322) of each UID. */
  fetch(uids: number[]): AsyncIterable<{ uid: number; source: Buffer }>;
}

function imapflowClient(config: Record<string, unknown>, password: string): ImapClient {
  if (typeof config.host !== "string" || typeof config.user !== "string") {
    throw new ConnectorError("an imap source needs a host and a user");
  }
  const client = new ImapFlow({
    host: config.host,
    port: typeof config.port === "number" ? config.port : 993,
    secure: config.secure !== false,
    auth: { user: config.user, pass: password },
    logger: false,
  });
  return {
    connect: () => client.connect(),
    logout: () => client.logout(),
    open: async (mailbox) => {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      const opened = client.mailbox;
      return { uidValidity: opened ? Number(opened.uidValidity) : 0, close: () => lock.release() };
    },
    search: async ({ after, since }) => {
      const found = await client.search({ uid: `${after + 1}:*`, ...(since ? { since } : {}) }, { uid: true });
      return (found || []).filter((uid) => uid > after);
    },
    fetch: async function* (uids) {
      if (uids.length === 0) return;
      for await (const message of client.fetch(uids.join(","), { uid: true, source: true }, { uid: true })) {
        if (message.source) yield { uid: message.uid, source: message.source };
      }
    },
  };
}

function addresses(field: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  return list.flatMap((entry) =>
    entry.value.map((address) =>
      address.name ? `${address.name} <${address.address ?? ""}>` : (address.address ?? ""),
    ),
  );
}

/**
 * Mailboxes over IMAP (INBOX unless `mailboxes` says otherwise), read-only. Each pull fetches only messages with a
 * UID above the last one seen; the first pull goes back `since_days` (90). A changed UIDVALIDITY starts the mailbox
 * over. Messages deleted on the server stay in the index until the source is removed.
 */
export async function pullImap(
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  options: { client?: ImapClient; env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<Pull> {
  const client = options.client ?? imapflowClient(config, await secretFor(config, options.env ?? process.env));
  const mailboxes = Array.isArray(config.mailboxes) ? (config.mailboxes as string[]) : ["INBOX"];
  const sinceDays = typeof config.since_days === "number" ? config.since_days : 90;
  const seen = (state.mailboxes ?? {}) as Record<string, { uidValidity: number; lastUid: number }>;
  const next: Record<string, { uidValidity: number; lastUid: number }> = {};
  const items: PulledItem[] = [];

  await client.connect();
  try {
    for (const mailbox of mailboxes) {
      const { uidValidity, close } = await client.open(mailbox);
      try {
        const previous = seen[mailbox];
        const fresh = !previous || previous.uidValidity !== uidValidity;
        const after = fresh ? 0 : previous.lastUid;
        const uids = await client.search({
          after,
          ...(fresh ? { since: new Date((options.now ?? Date.now()) - sinceDays * DAY) } : {}),
        });
        let lastUid = after;
        for await (const { uid, source } of client.fetch(uids)) {
          const mail = await simpleParser(source);
          items.push({
            key: `${mailbox}:${uidValidity}:${uid}`,
            kind: "mail",
            title: mail.subject ?? "(no subject)",
            body: (mail.text ?? "").trim().slice(0, MAX_BODY),
            people: [...addresses(mail.from), ...addresses(mail.to), ...addresses(mail.cc)],
            ts: mail.date?.getTime() ?? 0,
          });
          lastUid = Math.max(lastUid, uid);
        }
        next[mailbox] = { uidValidity, lastUid };
      } finally {
        close();
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { items, removed: [], state: { mailboxes: next } };
}
