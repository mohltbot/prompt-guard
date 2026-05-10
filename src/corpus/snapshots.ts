/**
 * Snapshot ingestion — captures code state at end of each Cowork session
 * plus .Trash reverted states. Content-addressed, gzipped for size > 1KB.
 *
 * For v0 (per Q1): one snapshot per Cowork session = the final outputs/ state.
 * Per-turn snapshot replay (file-history-snapshot events) is v1.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import Database from 'better-sqlite3';
import { glob } from 'glob';

const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z',
  '.pyc', '.pyo', '.so', '.dylib', '.dll', '.exe',
  '.mov', '.mp4', '.mp3', '.wav', '.ogg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.lock',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next',
  '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
]);

const MAX_FILE_BYTES = 1_000_000;     // 1MB
const COMPRESS_THRESHOLD = 1024;      // gzip if file > 1KB

export interface SnapshotStats {
  snapshotsInserted: number;
  snapshotsSkipped: number;
  filesAdded: number;
  blobsInserted: number;
  blobsReused: number;
  bytesStored: number;
}

export function newSnapshotStats(): SnapshotStats {
  return {
    snapshotsInserted: 0,
    snapshotsSkipped: 0,
    filesAdded: 0,
    blobsInserted: 0,
    blobsReused: 0,
    bytesStored: 0,
  };
}

interface FileEntry {
  relativePath: string;
  sizeBytes: number;
  contentHash: string;
  rawBytes: Buffer;
}

function walkFiles(rootDir: string): FileEntry[] {
  const entries: FileEntry[] = [];
  function recurse(dir: string, relPrefix: string): void {
    let dirents: fs.Dirent[];
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const d of dirents) {
      if (SKIP_DIRS.has(d.name)) continue;
      const full = path.join(dir, d.name);
      const rel = relPrefix ? `${relPrefix}/${d.name}` : d.name;
      if (d.isDirectory()) {
        recurse(full, rel);
      } else if (d.isFile()) {
        const ext = path.extname(d.name).toLowerCase();
        if (SKIP_EXTS.has(ext)) continue;
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.size > MAX_FILE_BYTES) continue;
        let bytes: Buffer;
        try { bytes = fs.readFileSync(full); } catch { continue; }
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        entries.push({ relativePath: rel, sizeBytes: stat.size, contentHash: hash, rawBytes: bytes });
      }
    }
  }
  recurse(rootDir, '');
  return entries;
}

function insertBlob(db: Database.Database, hash: string, bytes: Buffer): boolean {
  const existing = db.prepare('SELECT 1 FROM blobs WHERE content_hash = ?').get(hash);
  if (existing) return false;
  let toStore = bytes;
  let compressed = 0;
  if (bytes.length > COMPRESS_THRESHOLD) {
    try {
      toStore = zlib.gzipSync(bytes);
      compressed = 1;
    } catch {
      compressed = 0;
    }
  }
  db.prepare('INSERT INTO blobs (content_hash, content, is_compressed) VALUES (?, ?, ?)')
    .run(hash, toStore, compressed);
  return true;
}

function ingestSnapshot(
  db: Database.Database,
  args: {
    sessionId: string | null;
    projectId: string;
    snapshotType: 'cowork-outputs' | 'trash-snapshot' | 'forward-accept';
    sourcePath: string;
    capturedAt: string;
  },
  stats: SnapshotStats,
  force = false
): void {
  // Idempotency: if (session_id, source_path) already exists, skip unless --force
  if (!force) {
    const existing = db.prepare(`
      SELECT snapshot_id FROM code_snapshots
      WHERE source_path = ? AND snapshot_type = ?
        AND (session_id IS ? OR session_id = ?)
    `).get(args.sourcePath, args.snapshotType, args.sessionId, args.sessionId);
    if (existing) {
      stats.snapshotsSkipped += 1;
      return;
    }
  }

  if (!fs.existsSync(args.sourcePath)) {
    stats.snapshotsSkipped += 1;
    return;
  }

  const files = walkFiles(args.sourcePath);
  if (files.length === 0) {
    stats.snapshotsSkipped += 1;
    return;
  }

  const totalBytes = files.reduce((s, f) => s + f.sizeBytes, 0);

  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO code_snapshots
        (session_id, project_id, snapshot_type, source_path, captured_at, file_count, total_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(args.sessionId, args.projectId, args.snapshotType, args.sourcePath, args.capturedAt, files.length, totalBytes);

    const snapshotId = result.lastInsertRowid as number;

    const insertFile = db.prepare(`
      INSERT INTO code_files (snapshot_id, relative_path, content_hash, size_bytes)
      VALUES (?, ?, ?, ?)
    `);

    for (const f of files) {
      const inserted = insertBlob(db, f.contentHash, f.rawBytes);
      if (inserted) stats.blobsInserted += 1;
      else stats.blobsReused += 1;
      insertFile.run(snapshotId, f.relativePath, f.contentHash, f.sizeBytes);
      stats.filesAdded += 1;
    }
    stats.snapshotsInserted += 1;
    stats.bytesStored += totalBytes;
  });

  tx();
}

/**
 * Ingest Cowork outputs/ folders for all eligible Cowork sessions.
 */
export function ingestCoworkSnapshots(db: Database.Database, stats: SnapshotStats, force = false): void {
  const rows = db.prepare(`
    SELECT s.session_id, s.project_id, s.source_path, s.ended_at
    FROM sessions s
    WHERE s.source = 'cowork' AND s.is_eligible_for_corpus = 1
  `).all() as { session_id: string; project_id: string; source_path: string; ended_at: string | null }[];

  for (const row of rows) {
    // source_path is the local_<uuid>/ dir; outputs/ is a child
    const outputsDir = path.join(row.source_path, 'outputs');
    if (!fs.existsSync(outputsDir)) continue;
    ingestSnapshot(db, {
      sessionId: row.session_id,
      projectId: row.project_id,
      snapshotType: 'cowork-outputs',
      sourcePath: outputsDir,
      capturedAt: row.ended_at || new Date().toISOString(),
    }, stats, force);
  }
}

/**
 * Ingest ALL .Trash directories that contain code, regardless of project name match.
 * Project linkage is computed by the labeler via content_hash Jaccard overlap with
 * session snapshots — this is more robust than basename matching.
 *
 * Trash snapshots get a synthetic project_id of `trash:<basename-slug>`. The labeler
 * may re-tag them to a real project_id when it finds a Jaccard match.
 */
export function ingestTrashSnapshots(db: Database.Database, stats: SnapshotStats, force = false): void {
  const trashDir = path.join(os.homedir(), '.Trash');
  if (!fs.existsSync(trashDir)) return;

  let dirents: fs.Dirent[];
  try { dirents = fs.readdirSync(trashDir, { withFileTypes: true }); }
  catch { return; }

  for (const d of dirents) {
    if (!d.isDirectory()) continue;

    const fullPath = path.join(trashDir, d.name);

    // Drop trailing timestamps like " 8.44.09 AM" for nicer naming
    const baseGuess = d.name.toLowerCase().replace(/\s+\d{1,2}\.\d{2}\.\d{2}\s+(am|pm)$/, '').trim();
    const projectId = 'trash:' + baseGuess.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'trash:unnamed';

    let stat: fs.Stats;
    try { stat = fs.statSync(fullPath); } catch { continue; }

    // Quick smell test — does it have any code-shaped files? (uses walkFiles which already filters)
    const probe = walkFiles(fullPath);
    if (probe.length === 0) continue;

    // Ensure synthetic project exists
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO projects (project_id, cwd, name, explicit, created_at, last_seen_at)
      VALUES (?, NULL, ?, 0, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(projectId, baseGuess || d.name, now, now);

    ingestSnapshot(db, {
      sessionId: null,
      projectId,
      snapshotType: 'trash-snapshot',
      sourcePath: fullPath,
      capturedAt: stat.mtime.toISOString(),
    }, stats, force);
  }
}
