-- The team server's D1 database. It holds answers and summaries, never file contents (rule 4), and usage as numbers
-- per member and day, never prompts or keys (rule 2). Times are Unix milliseconds; days are UTC dates.

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

-- Every change gets a new seq (INSERT OR REPLACE), so clients pull what is newer than the last seq they saw.
-- A replaced or removed answer stays as a row with deleted = 1, so clients learn to drop it.
CREATE TABLE answers (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX answers_repo_seq ON answers (repo_id, seq);

CREATE TABLE summaries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (repo_id, path, blob_hash)
) STRICT;

CREATE INDEX summaries_repo_seq ON summaries (repo_id, seq);

CREATE TABLE usage (
  member_id TEXT NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  saved REAL NOT NULL DEFAULT 0,
  answer_hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, day)
) STRICT;

CREATE TABLE budgets (
  scope TEXT PRIMARY KEY CHECK (scope IN ('team', 'member')),
  limit_amount REAL NOT NULL
) STRICT;
