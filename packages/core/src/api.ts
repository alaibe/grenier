import type { Config } from "./config.ts";
import type { RoutineMode } from "./routines.ts";

// What the daemon's admin API answers the desktop app: the daemon checks what it sends against these.

/** A day's, a project's or a session's spend; a model with no price counts as 0 and in `unpriced`. */
export interface ReportRow {
  key: string;
  requests: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cost: number;
  unpriced: number;
  saved: number;
}

export interface SessionRow extends ReportRow {
  client: string | null;
  /** Null for requests of an agent not started with `grenier run`. */
  project: string | null;
  startedAt: number | null;
}

export interface Overview {
  version: string;
  /** Who writes from this machine: the member's name in the team, else this computer's user. */
  me: string;
  days: ReportRow[];
  /** The most spent first. */
  projects: ReportRow[];
  /** The newest first. */
  sessions: SessionRow[];
  /** Records changed here that the team store has not taken yet. */
  waiting: number;
  team: { url: string; lastSync: number | null } | null;
  /** In a team, this machine's person's role, admin or member: a member writes in Me only, and their agents' answers. */
  role: string | null;
  /** The team store is older than this Grenier: sync waits until it is deployed again. */
  outdated: boolean;
  /** Sessions the loop guard paused, waiting to be resumed. */
  paused: number;
}

export interface PausedSession {
  id: string;
  client: string | null;
  repo: string | null;
  pausedAt: number | null;
}

export interface Top {
  id: string;
  name: string;
  kind: "me" | "repo" | "team" | "custom";
  repoId: string | null;
  root: string | null;
  records: number;
}

export interface Anchor {
  kind: "git" | "item";
  repoId: string | null;
  ref: string;
  version: string;
}

export interface Link {
  kind: "record" | "person" | "repo" | "path" | "issue";
  ref: string;
}

/** A record as lists show it. */
export interface RecordRow {
  id: string;
  top: string;
  type: string;
  kind: string | null;
  title: string;
  /** Where it sits in its top folder, as "Decisions/2026"; empty at the top. */
  folder: string;
  body: string;
  fields: Record<string, unknown>;
  author: string;
  updatedAt: number;
  /** Whether the code it was written from is unchanged: stale when a file it names changed since. */
  status: "hit" | "stale" | "unchecked";
  changed: string[];
  anchors: Anchor[];
  links: Link[];
  /** How close it is to the words searched for, when embeddings are on. */
  similarity?: number;
}

/** A page in Knowledge's tree. */
export interface PageRow {
  id: string;
  top: string;
  folder: string;
  title: string;
  type: string;
  updatedAt: number;
}

export interface LinkedRecord {
  id: string;
  title: string;
  type: string;
}

export interface RecordFull extends RecordRow {
  device: string | null;
  createdAt: number;
  version: number;
  retiredAt: number | null;
  hits: number;
  linksTo: LinkedRecord[];
  linkedFrom: LinkedRecord[];
}

/** A record as the team store keeps it, which a conflict sends back. */
export type TeamRecord = Omit<RecordFull, "status" | "changed" | "similarity" | "hits" | "linksTo" | "linkedFrom">;

export interface HistoryEntry {
  version: number;
  author: string;
  device: string | null;
  ts: number;
  snapshot: Record<string, unknown>;
}

/** A page saved: shared at once, or `waiting` here for the next sync, with `team` false when there is none. */
export interface Saved {
  saved: string;
  waiting?: boolean;
  team?: boolean;
}

export interface Created extends Saved {
  id: string;
}

/** Someone saved the page since the version the editor started from: theirs. */
export interface Conflict {
  conflict: TeamRecord;
}

/** A stale anchor's file: the version the record was written from, and the one there is now; null when gone. */
export interface FileVersions {
  path: string;
  before: string | null;
  now: string | null;
}

/** Where joining from the app stands: waiting for the admin to confirm the code, then joined or failed. */
export interface Joining {
  state: "idle" | "waiting" | "joined" | "failed";
  code?: string;
  error?: string;
  url?: string;
  member?: string;
}

export interface Deployed {
  url: string;
  /** A new team store, of which this machine is the first admin; false for one updated in place. */
  created: boolean;
}

export interface Synced {
  pushed: number;
  refused: { recordId: string; reason: string }[];
  pulled: number;
  unopened: number;
}

// The team store's own pages, which the daemon passes on under /team: declared once here, checked by neither side.

export interface TeamMe {
  name: string;
  role: "admin" | "member";
  device: string;
  deviceId: string;
}

export interface Member {
  name: string;
  role: "admin" | "member";
  createdAt: number;
  devices: { id: string; name: string; state: string; lastSeen: number | null }[];
}

export interface Invite {
  id: string;
  member: string;
  role: string;
  expiresAt: number;
  device: string | null;
  /** The six digits the joining device shows, once it asked to join. */
  code: string | null;
}

export interface InviteMade {
  id: string;
  secret: string;
  member: string;
  newMember: boolean;
  expiresAt: number;
}

export interface Machine {
  id: string;
  name: string;
  member: string;
  state: string;
  lastSeen: number | null;
  runs: number;
}

export interface TeamTop {
  id: string;
  name: string;
  kind: string;
  repoId: string | null;
  /** Who reads a folder for some members; null for everyone. */
  members: string[] | null;
}

export interface TeamUsage {
  day: string;
  repo: string;
  member: string;
  machine: string;
  requests: number;
  cost: number;
  routine_minutes: number;
}

export interface Run {
  id: string;
  routine_id: string;
  task_id: string | null;
  machine: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  actions: number;
  cost: number;
}

/** Who else has a record open in the editor. */
export interface Editors {
  others: { member: string; device: string }[];
}

/** A web link's path on the team store. */
export interface MadeLink {
  path: string;
}

export interface SharedState {
  id: string;
  type: "Skill" | "McpServer";
  title: string;
  description: string;
  author: string;
  /** Installed as it is now, installed with a newer version waiting for approval, or not installed here. */
  state: "installed" | "update" | "available";
  credentials: string[];
  canRollBack: boolean;
}

/** A skill in this person's Claude Code skills, as the Skills screen lists it under Me. */
export interface LocalSkill {
  /** Its folder's name; `synced/<bucket>/<name>` or `plugin/<plugin>/<name>` for the ones Claude Code keeps. */
  id: string;
  name: string;
  description: string;
  /** Their own folder, a link to a folder elsewhere, synced from claude.ai, or a plugin's: only their own is edited here. */
  kind: "own" | "linked" | "synced" | "plugin";
  /** Its folder, or where its link points. */
  path: string;
}

/** A local skill with its SKILL.md and the names of its other files. */
export interface LocalSkillFull extends LocalSkill {
  manifest: string;
  files: string[];
}

/** A skill or server shared with the team, or a new version of one. */
export interface SharedNow {
  id: string;
  title: string;
  updated: boolean;
  /** For a skill fetched from GitHub: how many files it holds. */
  files?: number;
}

export interface FoundSkill {
  id: string;
  name: string;
  source: string;
  installs: number;
}

export interface FoundServer {
  name: string;
  title: string;
  description: string;
  version: string;
  config: Record<string, unknown>;
  credentials: string[];
  website: string | null;
}

export interface RoutineView {
  id: string;
  title: string;
  top: string;
  author: string;
  /** Null for a routine run by hand only. */
  schedule: string | null;
  agent: string;
  collector: boolean;
  /** What a run does: the routine's text. */
  prompt: string;
  /** How this machine's person approved it: its mode, and whether it changed since. */
  approval: { mode: RoutineMode; limit: number; current: boolean } | null;
}

/** A run of a routine on this machine. */
export interface LocalRun {
  id: string;
  routineId: string;
  trigger: string;
  status: "running" | "done" | "failed" | "cut";
  startedAt: number;
  endedAt: number | null;
  actions: number;
  result: string | null;
}

export type MachineRules = Config["machine"];

export interface Availability {
  state: "available" | "busy" | "away";
  /** How much this machine could take on, from 0 to 1: the team store offers work to the one with the most. */
  room: number;
  /** Why it is not available, in the words the app shows. */
  reasons: string[];
}

export interface MachineState extends Availability {
  rules: MachineRules;
  /** A run is going on this machine. */
  running: boolean;
}

/** How many of this person's Me pages this machine's key cannot open. */
export interface KeyState {
  unopened: number;
}

/** This person's key for the Me folder, shown when asked. */
export interface ShownKey {
  key: string;
}

/** An app on this computer Grenier can be added to. */
export interface AppView {
  app: string;
  label: string;
  connected: boolean;
}

/** An app that reads the store over MCP with a key of its own. */
export interface ClientView {
  name: string;
  scopes: string[];
  createdAt: number;
}

export interface Clients {
  clients: ClientView[];
  /** What a new key may read: * or a top folder's id. */
  scopes: string[];
}

export interface ClientMade {
  name: string;
  scopes: string[];
  /** Shown once. */
  token: string;
}
