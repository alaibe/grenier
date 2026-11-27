/** The team store's schema in steps: a store at version n runs the steps after the nth, in order. */
export const SCHEMA_STEPS: readonly string[] = [
  `
  CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_at INTEGER NOT NULL, removed_at INTEGER);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, member_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, revoked_at INTEGER, last_seen INTEGER,
    state TEXT NOT NULL DEFAULT 'offline', room REAL NOT NULL DEFAULT 0, repos TEXT NOT NULL DEFAULT '[]',
    agents TEXT NOT NULL DEFAULT '[]', state_at INTEGER
  );
  CREATE TABLE invites (
    id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, member_name TEXT NOT NULL, role TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER,
    device_name TEXT, device_hash TEXT, nonce TEXT, asked_at INTEGER
  );
  CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, repo_id TEXT, members TEXT);
  CREATE TABLE records (
    id TEXT PRIMARY KEY, space TEXT NOT NULL, type TEXT NOT NULL, kind TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
    fields TEXT NOT NULL, author TEXT NOT NULL, device TEXT, session_id TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, retired_at INTEGER, version INTEGER NOT NULL UNIQUE, anchors TEXT NOT NULL,
    links TEXT NOT NULL, sealed TEXT
  );
  CREATE INDEX records_space ON records (space, type);
  CREATE VIRTUAL TABLE records_fts USING fts5 (id UNINDEXED, title, body, tokenize = 'porter unicode61');
  CREATE TABLE history (
    record_id TEXT NOT NULL, version INTEGER NOT NULL, author TEXT NOT NULL, device TEXT, ts INTEGER NOT NULL,
    snapshot TEXT NOT NULL, PRIMARY KEY (record_id, version)
  );
  CREATE TABLE applied (change_id TEXT PRIMARY KEY, version INTEGER NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE claims (task_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, leased_until INTEGER NOT NULL, offered_at INTEGER NOT NULL);
  CREATE TABLE declines (task_id TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (task_id, device_id));
  CREATE TABLE usage (
    device_id TEXT NOT NULL, day TEXT NOT NULL, repo TEXT NOT NULL, requests INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cost REAL NOT NULL, routine_minutes REAL NOT NULL DEFAULT 0, PRIMARY KEY (device_id, day, repo)
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, task_id TEXT, device_id TEXT NOT NULL, version INTEGER NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, actions INTEGER NOT NULL,
    cost REAL NOT NULL, landed REAL, score REAL, thumbs INTEGER
  );
  CREATE TABLE webhooks (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, routine_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE weblinks (code_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
  CREATE TABLE schedules (routine_id TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
  INSERT INTO spaces (id, name, kind) VALUES ('team', 'team', 'team');
  INSERT INTO meta (key, value) VALUES ('schema', '1'), ('version', '0');
`,
  `
  ALTER TABLE records ADD COLUMN folder TEXT NOT NULL DEFAULT '';
  UPDATE meta SET value = '2' WHERE key = 'schema';
`,
  `
  ALTER TABLE spaces RENAME TO tops;
  ALTER TABLE records RENAME COLUMN space TO top;
  DROP INDEX records_space;
  CREATE INDEX records_top ON records (top, type);
  UPDATE meta SET value = '3' WHERE key = 'schema';
`,
  `
  DELETE FROM runs WHERE kind = 'eval';
  ALTER TABLE runs DROP COLUMN version;
  ALTER TABLE runs DROP COLUMN kind;
  ALTER TABLE runs DROP COLUMN landed;
  ALTER TABLE runs DROP COLUMN score;
  ALTER TABLE runs DROP COLUMN thumbs;
  UPDATE meta SET value = '4' WHERE key = 'schema';
`,
  `
  ALTER TABLE declines ADD COLUMN at INTEGER NOT NULL DEFAULT 0;
  UPDATE meta SET value = '5' WHERE key = 'schema';
`,
  `
  ALTER TABLE devices DROP COLUMN repos;
  UPDATE meta SET value = '6' WHERE key = 'schema';
`,
  `
  DROP TABLE webhooks;
  UPDATE meta SET value = '7' WHERE key = 'schema';
`,
  `
  DELETE FROM history WHERE record_id IN (SELECT id FROM records WHERE top IN (SELECT id FROM tops WHERE kind = 'custom'));
  DELETE FROM records WHERE top IN (SELECT id FROM tops WHERE kind = 'custom');
  DELETE FROM tops WHERE kind = 'custom';
  ALTER TABLE tops DROP COLUMN members;
  UPDATE meta SET value = '8' WHERE key = 'schema';
`,
  `
  ALTER TABLE records DROP COLUMN kind;
  UPDATE meta SET value = '9' WHERE key = 'schema';
`,
];
