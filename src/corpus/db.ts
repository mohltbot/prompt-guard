import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

export const DEFAULT_DB_PATH = path.join(os.homedir(), '.prompt-guard', 'corpus.db');

export interface OpenOptions {
  readonly?: boolean;
  dbPath?: string;
}

/**
 * Open the corpus DB. Creates the file + applies migrations on first open.
 * Idempotent — safe to call repeatedly.
 */
export function openDb(opts: OpenOptions = {}): Database.Database {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;

  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath, { readonly: opts.readonly || false });

  // Pragmas — performance + safety
  db.pragma('journal_mode = WAL');     // concurrent reader during writes
  db.pragma('synchronous = NORMAL');   // 2x faster, still safe with WAL
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');  // 256MB mmap

  if (!opts.readonly) {
    // Apply schema (CREATE IF NOT EXISTS — safe on re-open)
    db.exec(SCHEMA_SQL);

    // Record migration version
    const existing = db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(SCHEMA_VERSION);
    if (!existing) {
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        SCHEMA_VERSION,
        new Date().toISOString()
      );
    }
  }

  return db;
}

/**
 * Get DB stats for sanity checks.
 */
export function dbFileStats(dbPath: string = DEFAULT_DB_PATH): { exists: boolean; sizeBytes: number; mtime?: Date } {
  if (!fs.existsSync(dbPath)) return { exists: false, sizeBytes: 0 };
  const s = fs.statSync(dbPath);
  return { exists: true, sizeBytes: s.size, mtime: s.mtime };
}
