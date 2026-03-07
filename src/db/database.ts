import Database from "better-sqlite3";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLITE_DB_PATH } from "../config.js";

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "db",
  "schema.sql"
);

let db: Database.Database | null = null;

export function initDb(): void {
  if (db) return;
  mkdirSync(dirname(SQLITE_DB_PATH), { recursive: true });
  db = new Database(SQLITE_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized. Call setup_db first.");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function isDbInitialized(): boolean {
  if (db) return true;
  if (!existsSync(SQLITE_DB_PATH)) return false;
  try {
    const testDb = new Database(SQLITE_DB_PATH, { readonly: true });
    const row = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'")
      .get() as { name: string } | undefined;
    testDb.close();
    return !!row;
  } catch {
    return false;
  }
}

export function indexRepo(
  repo: string,
  files: Array<{ path: string; content: string }>
): void {
  const d = getDb();
  const txn = d.transaction(() => {
    d.prepare("DELETE FROM files WHERE repo = ?").run(repo);
    d.prepare("DELETE FROM repos WHERE repo = ?").run(repo);

    const insert = d.prepare(
      "INSERT INTO files (repo, path, content) VALUES (?, ?, ?)"
    );
    for (const f of files) {
      insert.run(repo, f.path, f.content);
    }

    d.prepare(
      "INSERT INTO repos (repo, file_count) VALUES (?, ?)"
    ).run(repo, files.length);
  });
  txn();
}

export function clearRepo(repo: string): void {
  const d = getDb();
  d.prepare("DELETE FROM files WHERE repo = ?").run(repo);
  d.prepare("DELETE FROM repos WHERE repo = ?").run(repo);
}

export interface IndexedRepo {
  repo: string;
  file_count: number;
  indexed_at: string;
}

export function getIndexedRepos(): IndexedRepo[] {
  const d = getDb();
  return d.prepare("SELECT repo, file_count, indexed_at FROM repos").all() as IndexedRepo[];
}

export interface FTSResult {
  path: string;
  repo: string;
  content: string;
}

export function searchFTS(opts: {
  query: string;
  mode: "substring" | "word";
  repo?: string;
  fileType?: string;
  limit: number;
}): FTSResult[] {
  const d = getDb();
  const table =
    opts.mode === "substring" ? "files_fts_substring" : "files_fts_word";

  let sql = `
    SELECT f.path, f.repo, f.content
    FROM ${table}
    JOIN files f ON ${table}.rowid = f.id
    WHERE ${table} MATCH ?
  `;
  const params: (string | number)[] = [opts.query];

  if (opts.repo) {
    sql += " AND f.repo = ?";
    params.push(opts.repo);
  }

  if (opts.fileType && opts.fileType !== "all") {
    const escaped = opts.fileType.replace(/[%_\\]/g, "\\$&");
    sql += " AND f.path LIKE ? ESCAPE '\\'";
    params.push(`%.${escaped}`);
  }

  sql += ` ORDER BY bm25(${table}) LIMIT ?`;
  params.push(opts.limit);

  return d.prepare(sql).all(...params) as FTSResult[];
}

export function getFile(
  repo: string,
  path: string
): { content: string } | undefined {
  const d = getDb();
  return d
    .prepare("SELECT content FROM files WHERE repo = ? AND path = ?")
    .get(repo, path) as { content: string } | undefined;
}

export function getFileList(repo: string, prefix?: string): string[] {
  const d = getDb();
  if (prefix) {
    const escaped = prefix.replace(/[%_\\]/g, "\\$&");
    return (
      d
        .prepare(
          "SELECT path FROM files WHERE repo = ? AND path LIKE ? ESCAPE '\\' ORDER BY path"
        )
        .all(repo, `${escaped}%`) as Array<{ path: string }>
    ).map((r) => r.path);
  }
  return (
    d
      .prepare("SELECT path FROM files WHERE repo = ? ORDER BY path")
      .all(repo) as Array<{ path: string }>
  ).map((r) => r.path);
}
