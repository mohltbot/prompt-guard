/**
 * `prompt-guard corpus stats` — sanity-check view of the ingested corpus.
 * Includes 5 random eligible user prompts from each top-3 project for hygiene-filter inspection.
 */

import chalk from 'chalk';
import { openDb, DEFAULT_DB_PATH, dbFileStats } from '../corpus/db';

export interface StatsOptions {
  dbPath?: string;
  promptSamplesPerProject?: number;   // default 5
  topN?: number;                       // default 3
}

interface ProjectRow {
  project_id: string;
  name: string | null;
  cwd: string | null;
  user_prompt_count: number;
  session_count: number;
  eligible_session_count: number;
}

export async function runStats(opts: StatsOptions = {}): Promise<void> {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const file = dbFileStats(dbPath);
  if (!file.exists) {
    console.log(chalk.yellow(`No corpus DB at ${dbPath}. Run \`prompt-guard ingest\` first.`));
    return;
  }
  const db = openDb({ dbPath, readonly: true });

  const samplesPerProject = opts.promptSamplesPerProject ?? 5;
  const topN = opts.topN ?? 3;

  // ----- Header -----
  console.log(chalk.bold('\n# Prompt Guard corpus\n'));
  console.log(`DB:           ${dbPath}  (${(file.sizeBytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Last ingest:  ${file.mtime?.toISOString()}`);
  console.log('');

  // ----- Sources -----
  const sourceRows = db.prepare(`
    SELECT source, COUNT(*) AS sessions FROM sessions GROUP BY source ORDER BY source
  `).all() as { source: string; sessions: number }[];
  console.log(chalk.bold('## Sources'));
  for (const r of sourceRows) {
    const promptCount = db.prepare(`
      SELECT COUNT(*) AS c FROM prompts p JOIN sessions s ON s.session_id = p.session_id
      WHERE s.source = ?
    `).get(r.source) as { c: number };
    console.log(`  ${r.source.padEnd(15)} ${String(r.sessions).padStart(6)} sessions  ${String(promptCount.c).padStart(8)} events`);
  }
  console.log('');

  // ----- Sessions -----
  const ses = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_eligible_for_corpus = 1 THEN 1 ELSE 0 END) AS eligible,
      SUM(CASE WHEN is_eligible_for_corpus = 0 THEN 1 ELSE 0 END) AS excluded,
      SUM(CASE WHEN scheduled_task_id IS NOT NULL THEN 1 ELSE 0 END) AS scheduled,
      SUM(CASE WHEN user_type IS NOT NULL AND user_type != 'external' AND scheduled_task_id IS NULL THEN 1 ELSE 0 END) AS non_external
    FROM sessions
  `).get() as { total: number; eligible: number; excluded: number; scheduled: number; non_external: number };
  console.log(chalk.bold('## Sessions'));
  console.log(`  Total       ${String(ses.total).padStart(6)}`);
  console.log(`  Eligible    ${String(ses.eligible).padStart(6)}    (${ses.total ? Math.round(100 * ses.eligible / ses.total) : 0}%)`);
  console.log(`  Excluded    ${String(ses.excluded).padStart(6)}`);
  console.log(`    └ scheduled task ${ses.scheduled}`);
  console.log(`    └ non-external   ${ses.non_external}`);
  console.log('');

  // ----- Projects (top-N by eligible user-prompt count) -----
  const topProjects = db.prepare(`
    SELECT
      p.project_id,
      p.name,
      p.cwd,
      COUNT(CASE WHEN pr.role = 'user' THEN 1 END) AS user_prompt_count,
      COUNT(DISTINCT s.session_id) AS session_count,
      COUNT(DISTINCT CASE WHEN s.is_eligible_for_corpus = 1 THEN s.session_id END) AS eligible_session_count
    FROM projects p
    JOIN sessions s ON s.project_id = p.project_id AND s.is_eligible_for_corpus = 1
    JOIN prompts pr ON pr.session_id = s.session_id
    GROUP BY p.project_id
    ORDER BY user_prompt_count DESC
    LIMIT ?
  `).all(Math.max(topN, 5)) as ProjectRow[];

  console.log(chalk.bold(`## Projects (top ${topProjects.length} by eligible user prompts)`));
  topProjects.forEach((row, i) => {
    const label = row.name || row.cwd || row.project_id.slice(0, 12);
    const labelTrunc = label.length > 50 ? label.slice(0, 47) + '...' : label;
    console.log(
      `  ${i + 1}. ${labelTrunc.padEnd(50)} ${String(row.user_prompt_count).padStart(6)} user prompts   ${String(row.eligible_session_count).padStart(3)} sessions`
    );
  });
  console.log('');

  // ----- Prompts -----
  const pr = db.prepare(`
    SELECT
      role,
      COUNT(*) AS total,
      SUM(CASE WHEN s.is_eligible_for_corpus = 1 THEN 1 ELSE 0 END) AS eligible
    FROM prompts p
    JOIN sessions s ON s.session_id = p.session_id
    GROUP BY role
  `).all() as { role: string; total: number; eligible: number }[];
  console.log(chalk.bold('## Prompts'));
  for (const row of pr) {
    console.log(`  ${row.role.padEnd(10)}  total ${String(row.total).padStart(7)}    eligible ${String(row.eligible).padStart(7)}`);
  }
  console.log('');

  // ----- Tool calls -----
  const tools = db.prepare(`
    SELECT operation, COUNT(*) AS c FROM tool_calls GROUP BY operation ORDER BY c DESC LIMIT 10
  `).all() as { operation: string | null; c: number }[];
  const toolTotal = db.prepare(`SELECT COUNT(*) AS c FROM tool_calls`).get() as { c: number };
  console.log(chalk.bold('## Tool calls'));
  console.log(`  Total ${toolTotal.c}`);
  for (const t of tools) {
    console.log(`    ${(t.operation || '?').padEnd(10)} ${t.c}`);
  }
  console.log('');

  // ----- Sample prompts for sanity check -----
  console.log(chalk.bold(`## Random sample — ${samplesPerProject} eligible user prompts per top-${topN} project`));
  console.log(chalk.gray('(For sanity checking hygiene filters)'));
  console.log('');

  for (const proj of topProjects.slice(0, topN)) {
    const label = proj.name || proj.cwd || proj.project_id.slice(0, 12);
    console.log(chalk.bold(`### ${label}`));
    if (proj.cwd) console.log(chalk.gray(`    cwd: ${proj.cwd}`));
    const samples = db.prepare(`
      SELECT
        p.prompt_id, p.session_id, p.turn_index, p.timestamp, p.content,
        s.title
      FROM prompts p
      JOIN sessions s ON s.session_id = p.session_id
      WHERE p.project_id = ?
        AND s.is_eligible_for_corpus = 1
        AND p.role = 'user'
        AND length(p.content) > 20
      ORDER BY RANDOM()
      LIMIT ?
    `).all(proj.project_id, samplesPerProject) as {
      prompt_id: number;
      session_id: string;
      turn_index: number;
      timestamp: string;
      content: string;
      title: string | null;
    }[];

    if (samples.length === 0) {
      console.log(chalk.yellow('    (no eligible user prompts)'));
    } else {
      samples.forEach((s, i) => {
        const sid = s.session_id.length > 12 ? s.session_id.slice(0, 12) + '…' : s.session_id;
        const preview = s.content.replace(/\s+/g, ' ').slice(0, 200);
        const ts = s.timestamp.slice(0, 16);
        console.log(`    [${i + 1}] turn ${s.turn_index} of ${sid}  (${ts})${s.title ? '  · ' + s.title.slice(0, 30) : ''}`);
        console.log(chalk.gray(`        "${preview}${s.content.length > 200 ? '…' : ''}"`));
      });
    }
    console.log('');
  }

  // ----- Excluded sample (audit the hygiene filter) -----
  console.log(chalk.bold('## Sample of EXCLUDED sessions (hygiene-filter audit)'));
  const excluded = db.prepare(`
    SELECT session_id, scheduled_task_id, user_type, title, source
    FROM sessions
    WHERE is_eligible_for_corpus = 0
    ORDER BY RANDOM()
    LIMIT 5
  `).all() as { session_id: string; scheduled_task_id: string | null; user_type: string | null; title: string | null; source: string }[];
  if (excluded.length === 0) {
    console.log(chalk.gray('  (none)'));
  } else {
    excluded.forEach((s, i) => {
      console.log(`  [${i + 1}] ${s.session_id.slice(0, 16)}…  source=${s.source}  sched=${s.scheduled_task_id || '-'}  user_type=${s.user_type || '-'}  title=${(s.title || '').slice(0, 40)}`);
    });
  }
  console.log('');

  // ----- Snapshots -----
  const snapTotals = db.prepare(`
    SELECT snapshot_type, COUNT(*) AS c, SUM(file_count) AS files, SUM(total_bytes) AS bytes
    FROM code_snapshots GROUP BY snapshot_type
  `).all() as { snapshot_type: string; c: number; files: number; bytes: number }[];
  if (snapTotals.length > 0) {
    console.log(chalk.bold('## Code snapshots'));
    for (const t of snapTotals) {
      console.log(`  ${t.snapshot_type.padEnd(18)} ${String(t.c).padStart(4)} snapshots   ${String(t.files || 0).padStart(6)} files   ${((t.bytes || 0) / 1024 / 1024).toFixed(2)} MB`);
    }
    const blobStats = db.prepare(`SELECT COUNT(*) AS c, SUM(LENGTH(content)) AS stored FROM blobs`).get() as { c: number; stored: number };
    console.log(`  ${chalk.gray('blobs (dedup):')}     ${blobStats.c} unique  ${(blobStats.stored / 1024 / 1024).toFixed(2)} MB on disk`);
    console.log('');
  }

  // ----- Outcomes -----
  const outcomes = db.prepare(`
    SELECT outcome, COUNT(*) AS c FROM session_outcomes GROUP BY outcome
  `).all() as { outcome: string; c: number }[];
  if (outcomes.length > 0) {
    console.log(chalk.bold('## Session outcomes'));
    for (const o of outcomes) {
      console.log(`  ${o.outcome.padEnd(10)} ${o.c}`);
    }
    console.log('');
  }

  // ----- Clarifying pairs by project (the load-bearing density metric) -----
  const pairsByProject = db.prepare(`
    SELECT
      p.project_id,
      pr.name,
      COUNT(*) AS pair_count,
      COUNT(DISTINCT cp.clarification_kind) AS distinct_kinds,
      COUNT(DISTINCT cp.session_id) AS sessions
    FROM clarifying_pairs cp
    JOIN prompts p ON p.prompt_id = cp.originating_prompt_id
    JOIN projects pr ON pr.project_id = p.project_id
    WHERE cp.extraction_method = 'rule'
    GROUP BY p.project_id
    ORDER BY pair_count DESC
    LIMIT 10
  `).all() as { project_id: string; name: string | null; pair_count: number; distinct_kinds: number; sessions: number }[];

  if (pairsByProject.length > 0) {
    console.log(chalk.bold('## Clarifying pairs (rule v0) — by project, top 10'));
    console.log(chalk.gray('   Density-ranked. This is what gold-subset selection should target, not raw prompt count.'));
    pairsByProject.forEach((p, i) => {
      const label = (p.name || p.project_id.slice(0, 12));
      const labelTrunc = label.length > 50 ? label.slice(0, 47) + '...' : label;
      console.log(`  ${(i + 1).toString().padStart(2)}. ${labelTrunc.padEnd(50)} ${String(p.pair_count).padStart(4)} pairs   ${p.distinct_kinds} kinds   ${p.sessions} session(s)`);
    });
    console.log('');

    // Kind breakdown
    const kindRows = db.prepare(`
      SELECT clarification_kind, COUNT(*) AS c FROM clarifying_pairs
      WHERE extraction_method = 'rule' GROUP BY clarification_kind ORDER BY c DESC
    `).all() as { clarification_kind: string | null; c: number }[];
    console.log(chalk.bold('## Clarifying pairs — by kind'));
    for (const k of kindRows) {
      console.log(`  ${(k.clarification_kind || '?').padEnd(18)} ${k.c}`);
    }
    console.log('');

    // Random samples — 5 per top-2 project (the developer's MVP-1 inspection ask)
    const top2 = pairsByProject.slice(0, 2);
    console.log(chalk.bold('## Random sample — 5 clarifying pairs per top-2 project'));
    console.log(chalk.gray('   (For sanity-check before LLM extractor runs)'));
    console.log('');
    for (const proj of top2) {
      const label = proj.name || proj.project_id.slice(0, 12);
      console.log(chalk.bold(`### ${label}`));
      const samples = db.prepare(`
        SELECT
          cp.pair_id, cp.clarification_kind, cp.clarification_text, cp.confidence,
          orig.content AS orig_content, orig.turn_index AS orig_turn,
          clar.content AS clar_content, clar.turn_index AS clar_turn,
          cp.session_id
        FROM clarifying_pairs cp
        JOIN prompts orig ON orig.prompt_id = cp.originating_prompt_id
        JOIN prompts clar ON clar.prompt_id = cp.clarifying_prompt_id
        WHERE cp.extraction_method = 'rule' AND orig.project_id = ?
        ORDER BY RANDOM()
        LIMIT 5
      `).all(proj.project_id) as {
        pair_id: number; clarification_kind: string; clarification_text: string;
        confidence: number; orig_content: string; orig_turn: number;
        clar_content: string; clar_turn: number; session_id: string;
      }[];
      if (samples.length === 0) {
        console.log(chalk.gray('    (no pairs)'));
      } else {
        samples.forEach((s, i) => {
          const sid = s.session_id.length > 12 ? s.session_id.slice(0, 12) + '…' : s.session_id;
          const orig = s.orig_content.replace(/\s+/g, ' ').slice(0, 140);
          const clar = s.clar_content.replace(/\s+/g, ' ').slice(0, 140);
          console.log(`    [${i + 1}] kind=${chalk.cyan(s.clarification_kind)} conf=${s.confidence.toFixed(2)} session=${sid} (turns ${s.orig_turn}→${s.clar_turn})`);
          console.log(chalk.gray(`        ORIG : "${orig}${s.orig_content.length > 140 ? '…' : ''}"`));
          console.log(chalk.gray(`        CLAR : "${clar}${s.clar_content.length > 140 ? '…' : ''}"`));
          console.log(chalk.gray(`        EXTRACTED: ${s.clarification_text.slice(0, 200)}`));
        });
      }
      console.log('');
    }
  }

  db.close();
}
