/**
 * `prompt-guard ingest [--source claude-code|cowork|all] [--dry-run] [--db-path <path>]`
 */

import chalk from 'chalk';
import { openDb, DEFAULT_DB_PATH, dbFileStats } from '../corpus/db';
import { findClaudeCodeFiles, parseClaudeCodeFile } from '../corpus/parsers/claude-code';
import { findCoworkSessions, parseCoworkSession } from '../corpus/parsers/cowork';
import { writeSession, newWriteStats } from '../corpus/writer';
import { ingestCoworkSnapshots, ingestTrashSnapshots, newSnapshotStats } from '../corpus/snapshots';
import { runLabeler } from '../corpus/labeler';

export interface IngestOptions {
  source?: 'claude-code' | 'cowork' | 'all';
  dryRun?: boolean;
  dbPath?: string;
  verbose?: boolean;
  skipSnapshots?: boolean;
  skipLabeler?: boolean;
  forceSnapshots?: boolean;
}

export async function runIngest(opts: IngestOptions = {}): Promise<void> {
  const source = opts.source || 'all';
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;

  const before = dbFileStats(dbPath);
  console.log(chalk.bold('\nPrompt Guard ingest'));
  console.log(chalk.gray(`  DB:        ${dbPath}`));
  console.log(chalk.gray(`  Source:    ${source}`));
  console.log(chalk.gray(`  Dry-run:   ${opts.dryRun ? 'yes' : 'no'}`));
  if (before.exists) {
    console.log(chalk.gray(`  Existing:  ${(before.sizeBytes / 1024).toFixed(1)} KB, last modified ${before.mtime?.toISOString()}`));
  } else {
    console.log(chalk.gray('  Existing:  (none — creating)'));
  }
  console.log('');

  const db = opts.dryRun ? null : openDb({ dbPath });
  const stats = newWriteStats();
  const startTime = Date.now();

  // ----- Claude Code -----
  if (source === 'claude-code' || source === 'all') {
    const files = await findClaudeCodeFiles();
    console.log(chalk.bold(`Claude Code: ${files.length} JSONL files`));
    let i = 0;
    for (const f of files) {
      i += 1;
      try {
        const parsed = await parseClaudeCodeFile(f);
        if (!parsed) {
          if (opts.verbose) console.log(chalk.gray(`  [${i}/${files.length}] empty: ${f}`));
          continue;
        }
        if (opts.verbose) {
          console.log(chalk.gray(
            `  [${i}/${files.length}] ${parsed.sessionId.slice(0, 8)}… events=${parsed.events.length} cwd=${parsed.cwd || '?'}`
          ));
        }
        if (db) writeSession(db, parsed, stats);
      } catch (e) {
        console.error(chalk.red(`  ERROR parsing ${f}: ${e instanceof Error ? e.message : e}`));
      }
      if (!opts.verbose && (i % 5 === 0 || i === files.length)) {
        process.stdout.write(`\r  Parsed ${i}/${files.length} files`);
      }
    }
    if (!opts.verbose) process.stdout.write('\n');
  }

  // ----- Cowork -----
  if (source === 'cowork' || source === 'all') {
    const sessions = await findCoworkSessions();
    console.log(chalk.bold(`\nCowork:      ${sessions.length} local_<uuid>/audit.jsonl files`));
    let i = 0;
    for (const auditPath of sessions) {
      i += 1;
      try {
        const parsed = await parseCoworkSession(auditPath);
        if (!parsed || parsed.events.length === 0) {
          if (opts.verbose) console.log(chalk.gray(`  [${i}/${sessions.length}] empty: ${auditPath}`));
          continue;
        }
        if (opts.verbose) {
          console.log(chalk.gray(
            `  [${i}/${sessions.length}] ${parsed.sessionId.slice(0, 16)}… events=${parsed.events.length} sched=${parsed.scheduledTaskId || '-'}`
          ));
        }
        if (db) writeSession(db, parsed, stats);
      } catch (e) {
        console.error(chalk.red(`  ERROR parsing ${auditPath}: ${e instanceof Error ? e.message : e}`));
      }
      if (!opts.verbose && (i % 25 === 0 || i === sessions.length)) {
        process.stdout.write(`\r  Parsed ${i}/${sessions.length} sessions`);
      }
    }
    if (!opts.verbose) process.stdout.write('\n');
  }

  // ----- Snapshots (Cowork outputs/ + .Trash) -----
  const snapStats = newSnapshotStats();
  if (db && !opts.skipSnapshots) {
    console.log('');
    console.log(chalk.bold('Ingesting code snapshots…'));
    ingestCoworkSnapshots(db, snapStats, opts.forceSnapshots);
    ingestTrashSnapshots(db, snapStats, opts.forceSnapshots);
    console.log(`  Snapshots inserted: ${chalk.green(snapStats.snapshotsInserted)}  skipped: ${snapStats.snapshotsSkipped}`);
    console.log(`  Files added:        ${snapStats.filesAdded}`);
    console.log(`  Blobs:              ${chalk.green(snapStats.blobsInserted)} new, ${chalk.cyan(snapStats.blobsReused)} reused`);
    console.log(`  Bytes stored:       ${(snapStats.bytesStored / 1024 / 1024).toFixed(2)} MB`);
  }

  // ----- Labeler (outcomes + clarifying_pairs) -----
  if (db && !opts.skipLabeler) {
    console.log('');
    console.log(chalk.bold('Running labeler…'));
    const lab = runLabeler(db);
    console.log(`  Outcomes:  accepted ${chalk.green(lab.outcomesAccepted)}  iterated ${chalk.cyan(lab.outcomesIterated)}  rejected ${chalk.red(lab.outcomesRejected)}  unknown ${chalk.yellow(lab.outcomesUnknown)}`);
    console.log(`  Clarifying pairs (rule v0): ${chalk.green(lab.pairsInserted)}`);
  }

  if (db) db.close();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log(chalk.bold('Ingest summary'));
  console.log(`  Sessions inserted: ${chalk.green(stats.sessionsInserted)}`);
  console.log(`  Sessions updated:  ${chalk.cyan(stats.sessionsUpdated)}`);
  console.log(`  Sessions excluded: ${chalk.yellow(stats.sessionsExcluded)}  (scheduled or non-external)`);
  console.log(`  Prompts inserted:  ${chalk.green(stats.promptsInserted)}`);
  console.log(`  Tool calls:        ${chalk.green(stats.toolCallsInserted)}`);
  console.log(`  Elapsed:           ${elapsed}s`);
  console.log('');
  console.log(chalk.gray('Run `prompt-guard corpus stats` to inspect.'));
}
