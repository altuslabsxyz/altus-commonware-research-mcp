-- FTS5 schema for local code indexing (adapted from reference D1 migration)

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  UNIQUE(repo, path)
);

CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts_substring USING fts5(
  path, content, content='files', content_rowid='id', tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts_word USING fts5(
  path, content, content='files', content_rowid='id', tokenize='unicode61'
);

-- Triggers keep FTS in sync
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts_substring(rowid, path, content) VALUES (new.id, new.path, new.content);
  INSERT INTO files_fts_word(rowid, path, content) VALUES (new.id, new.path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts_substring(files_fts_substring, rowid, path, content) VALUES ('delete', old.id, old.path, old.content);
  INSERT INTO files_fts_word(files_fts_word, rowid, path, content) VALUES ('delete', old.id, old.path, old.content);
END;

CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
  INSERT INTO files_fts_substring(files_fts_substring, rowid, path, content) VALUES ('delete', old.id, old.path, old.content);
  INSERT INTO files_fts_substring(rowid, path, content) VALUES (new.id, new.path, new.content);
  INSERT INTO files_fts_word(files_fts_word, rowid, path, content) VALUES ('delete', old.id, old.path, old.content);
  INSERT INTO files_fts_word(rowid, path, content) VALUES (new.id, new.path, new.content);
END;

CREATE TABLE IF NOT EXISTS repos (
  repo TEXT PRIMARY KEY,
  file_count INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
