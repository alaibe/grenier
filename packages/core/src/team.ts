import type { Anchor, Link } from "./api.ts";

/** What a machine and the team store built from this tree speak, checked before a sync: 2 added folders, 3 named top folders, 4 one text per routine, 5 claimed runs and removable machines, 6 no more member-only folders. */
export const TEAM_PROTOCOL = 6;

/** The parts of a record a change carries, which the team store applies over what it has. */
export const RECORD_PARTS = [
  "top",
  "type",
  "kind",
  "title",
  "folder",
  "body",
  "fields",
  "retiredAt",
  "anchors",
  "links",
] as const;

/** What a `me` record's seal holds: every part but its top folder and when it was retired. */
export const SEALED_PARTS = ["type", "kind", "title", "folder", "body", "fields", "anchors", "links"] as const;

/** A top folder's name as people and agents write it: Me, Team, or a repository's folder name. */
export function topName(top: { kind: string; name: string }): string {
  if (top.kind === "me") return "Me";
  if (top.kind === "team") return "Team";
  return top.name;
}

/** The link an admin sends a new machine: the team store's host, the invite and its secret. */
export const inviteLink = (url: string, invite: string, secret: string) =>
  `grenier://join/${new URL(url).host}/${invite}/${secret}`;

/** A record as the team store keeps and sends it. In a `me` top folder, `sealed` holds it encrypted and the rest is empty. */
export interface StoredRecord {
  id: string;
  top: string;
  type: string;
  kind: string | null;
  title: string;
  folder: string;
  body: string;
  fields: Record<string, unknown>;
  author: string;
  device: string | null;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  retiredAt: number | null;
  version: number;
  anchors: Anchor[];
  links: Link[];
  sealed: string | null;
}

/** A member's own top folder in the team store. */
export const meTop = (memberId: string) => `me:${memberId}`;
