-- Phase 1: sessions and usage, the exploration cache, budgets and client tokens.
-- Times are Unix milliseconds. Question embeddings (sqlite-vec) come with the embedding model.

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  client TEXT,
  repo_root TEXT,
  repo_id TEXT,
  cwd TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  paused INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX sessions_repo ON sessions (repo_id);

CREATE TABLE usage (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  cache_write_tokens INTEGER,
  cache_read_tokens INTEGER,
  output_tokens INTEGER,
  cost REAL,
  status INTEGER
) STRICT;

CREATE INDEX usage_session_ts ON usage (session_id, ts);
CREATE INDEX usage_ts ON usage (ts);

-- Loop detected, budget hit, pause, resume.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
) STRICT;

CREATE INDEX events_session_ts ON events (session_id, ts);

CREATE TABLE file_summaries (
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, path, blob_hash)
) STRICT;

-- `seq` is the full-text index's rowid: an implicit rowid can change on VACUUM, which would detach the index.
CREATE TABLE answers (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  author TEXT NOT NULL
) STRICT;

CREATE INDEX answers_repo ON answers (repo_id);

-- An answer is valid only while every one of its files still has the blob hash recorded here.
CREATE TABLE answer_sources (
  answer_id TEXT NOT NULL REFERENCES answers (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  PRIMARY KEY (answer_id, path)
) STRICT;

CREATE VIRTUAL TABLE answers_fts USING fts5 (question, answer, content = 'answers', content_rowid = 'seq');

CREATE TRIGGER answers_fts_insert AFTER INSERT ON answers BEGIN
  INSERT INTO answers_fts (rowid, question, answer) VALUES (new.seq, new.question, new.answer);
END;

CREATE TRIGGER answers_fts_delete AFTER DELETE ON answers BEGIN
  INSERT INTO answers_fts (answers_fts, rowid, question, answer) VALUES ('delete', old.seq, old.question, old.answer);
END;

CREATE TRIGGER answers_fts_update AFTER UPDATE OF question, answer ON answers BEGIN
  INSERT INTO answers_fts (answers_fts, rowid, question, answer) VALUES ('delete', old.seq, old.question, old.answer);
  INSERT INTO answers_fts (rowid, question, answer) VALUES (new.seq, new.question, new.answer);
END;

CREATE TABLE budgets (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  limit_amount REAL NOT NULL,
  period TEXT NOT NULL,
  PRIMARY KEY (scope, key, period)
) STRICT;

-- `scopes` is a JSON list of source ids. Tokens are stored hashed.
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
