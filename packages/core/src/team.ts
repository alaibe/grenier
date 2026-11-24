/** What a machine and the team store built from this tree speak, checked before a sync: 2 added folders, 3 named top folders, 4 one text per routine, 5 claimed runs and removable machines. */
export const TEAM_PROTOCOL = 5;

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

/** A top folder's name as people and agents write it: Me, Team, a repository's folder name, or a member-only one's. */
export function topName(top: { kind: string; name: string }): string {
  if (top.kind === "me") return "Me";
  if (top.kind === "team") return "Team";
  return top.name;
}
