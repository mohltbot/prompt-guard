/**
 * Corpus DB schema. Single source of truth.
 * Migrations are version-numbered and idempotent (CREATE IF NOT EXISTS).
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
-- ============================================================
-- Migration tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL
);

-- ============================================================
-- Projects
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
    project_id      TEXT PRIMARY KEY,
    cwd             TEXT,
    name            TEXT,
    explicit        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_cwd ON projects(cwd);

-- ============================================================
-- Sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
    session_id              TEXT PRIMARY KEY,
    project_id              TEXT NOT NULL REFERENCES projects(project_id),
    source                  TEXT NOT NULL CHECK (source IN ('claude-code','cowork','manual')),
    source_path             TEXT NOT NULL,
    cwd                     TEXT,
    started_at              TEXT NOT NULL,
    ended_at                TEXT,
    title                   TEXT,
    model                   TEXT,
    git_branch              TEXT,
    scheduled_task_id       TEXT,
    user_type               TEXT,
    is_eligible_for_corpus  INTEGER NOT NULL DEFAULT 1,
    turn_count              INTEGER,
    raw_meta_json           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_eligible ON sessions(is_eligible_for_corpus);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

-- ============================================================
-- Prompts (every user/assistant turn)
-- ============================================================
CREATE TABLE IF NOT EXISTS prompts (
    prompt_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT NOT NULL REFERENCES sessions(session_id),
    project_id          TEXT NOT NULL REFERENCES projects(project_id),
    turn_index          INTEGER NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content             TEXT NOT NULL,
    normalized_content  TEXT,
    raw_event_json      TEXT,
    timestamp           TEXT NOT NULL,
    has_files           INTEGER,
    has_tests           INTEGER,
    has_criteria        INTEGER,
    has_constraints     INTEGER,
    has_local_env       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id);
CREATE INDEX IF NOT EXISTS idx_prompts_role ON prompts(role);

-- BM25 index — populated only with eligible USER prompts via triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
    content,
    project_id UNINDEXED,
    session_id UNINDEXED,
    prompt_id UNINDEXED,
    tokenize='porter unicode61'
);

-- Trigger: insert into FTS only if eligible + user role.
-- Uses sub-select on sessions to avoid FTS contamination from filtered sessions.
CREATE TRIGGER IF NOT EXISTS prompts_fts_ai AFTER INSERT ON prompts
WHEN NEW.role = 'user'
BEGIN
    INSERT INTO prompts_fts(rowid, content, project_id, session_id, prompt_id)
    SELECT NEW.prompt_id, NEW.normalized_content, NEW.project_id, NEW.session_id, NEW.prompt_id
    FROM sessions WHERE session_id = NEW.session_id AND is_eligible_for_corpus = 1;
END;

CREATE TRIGGER IF NOT EXISTS prompts_fts_ad AFTER DELETE ON prompts
WHEN OLD.role = 'user'
BEGIN
    DELETE FROM prompts_fts WHERE rowid = OLD.prompt_id;
END;

-- ============================================================
-- Tool calls
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_calls (
    tool_call_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_id       INTEGER REFERENCES prompts(prompt_id),
    session_id      TEXT NOT NULL REFERENCES sessions(session_id),
    tool_name       TEXT NOT NULL,
    file_path       TEXT,
    operation       TEXT,
    success         INTEGER,
    timestamp       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tools_file ON tool_calls(file_path);
CREATE INDEX IF NOT EXISTS idx_tools_session ON tool_calls(session_id);

-- ============================================================
-- Code snapshots (per-session for v0)
-- ============================================================
CREATE TABLE IF NOT EXISTS code_snapshots (
    snapshot_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT REFERENCES sessions(session_id),
    project_id      TEXT NOT NULL REFERENCES projects(project_id),
    snapshot_type   TEXT NOT NULL CHECK (snapshot_type IN
                       ('cowork-outputs','trash-snapshot','forward-accept')),
    source_path     TEXT NOT NULL,
    captured_at     TEXT NOT NULL,
    file_count      INTEGER,
    total_bytes     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project_time ON code_snapshots(project_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON code_snapshots(session_id);

CREATE TABLE IF NOT EXISTS code_files (
    snapshot_id     INTEGER NOT NULL REFERENCES code_snapshots(snapshot_id) ON DELETE CASCADE,
    relative_path   TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_code_files_hash ON code_files(content_hash);

CREATE TABLE IF NOT EXISTS blobs (
    content_hash    TEXT PRIMARY KEY,
    content         BLOB NOT NULL,
    is_compressed   INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- Outcomes (derived, re-runnable)
-- ============================================================
CREATE TABLE IF NOT EXISTS session_outcomes (
    session_id              TEXT PRIMARY KEY REFERENCES sessions(session_id),
    outcome                 TEXT NOT NULL CHECK (outcome IN
                              ('accepted','rejected','iterated','unknown')),
    is_in_trash             INTEGER NOT NULL DEFAULT 0,
    has_successor           INTEGER NOT NULL DEFAULT 0,
    successor_session_id    TEXT,
    turn_count              INTEGER,
    labeler_version         TEXT,
    labeled_at              TEXT
);

-- ============================================================
-- Clarifying pairs (rule, llm, manual — same table, distinguished by extraction_method)
-- ============================================================
CREATE TABLE IF NOT EXISTS clarifying_pairs (
    pair_id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    originating_prompt_id   INTEGER NOT NULL REFERENCES prompts(prompt_id),
    clarifying_prompt_id    INTEGER NOT NULL REFERENCES prompts(prompt_id),
    session_id              TEXT NOT NULL REFERENCES sessions(session_id),
    clarification_text      TEXT NOT NULL,
    clarification_kind      TEXT,
    extraction_method       TEXT NOT NULL CHECK (extraction_method IN ('rule','llm','manual')),
    extractor_version       TEXT,
    confidence              REAL,
    extracted_at            TEXT NOT NULL,
    is_in_gold_subset       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_clarpairs_originating ON clarifying_pairs(originating_prompt_id);
CREATE INDEX IF NOT EXISTS idx_clarpairs_kind ON clarifying_pairs(clarification_kind);
CREATE INDEX IF NOT EXISTS idx_clarpairs_method ON clarifying_pairs(extraction_method);

-- View: high-confidence "wide gold" = rule + llm agree on kind for same originating prompt.
CREATE VIEW IF NOT EXISTS high_confidence_clarifications AS
SELECT
    cp_rule.originating_prompt_id,
    cp_rule.clarifying_prompt_id,
    cp_rule.session_id,
    cp_rule.clarification_text,
    cp_rule.clarification_kind,
    'rule+llm' AS extraction_method,
    MIN(cp_rule.confidence, cp_llm.confidence) AS confidence
FROM clarifying_pairs cp_rule
INNER JOIN clarifying_pairs cp_llm
    ON cp_rule.originating_prompt_id = cp_llm.originating_prompt_id
    AND cp_rule.extraction_method = 'rule'
    AND cp_llm.extraction_method = 'llm'
    AND cp_rule.clarification_kind = cp_llm.clarification_kind;

-- ============================================================
-- Eval harness — every backtest run + every case it scored.
-- ============================================================
CREATE TABLE IF NOT EXISTS eval_runs (
    run_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at          TEXT NOT NULL,
    finished_at         TEXT,
    check_version       TEXT NOT NULL,
    question_gen_model  TEXT NOT NULL,
    retrieval_method    TEXT NOT NULL,
    retrieval_k         INTEGER NOT NULL,
    case_count          INTEGER,
    overlap_at_1        REAL,
    overlap_at_3        REAL,
    coverage            REAL,
    kind_match_rate     REAL,
    median_latency_ms   INTEGER,
    total_cost_usd      REAL,
    notes               TEXT
);

CREATE TABLE IF NOT EXISTS eval_cases (
    eval_case_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                  INTEGER NOT NULL REFERENCES eval_runs(run_id),
    originating_prompt_id   INTEGER NOT NULL REFERENCES prompts(prompt_id),
    proposed_questions_json TEXT NOT NULL,
    gold_clarifications_json TEXT NOT NULL,
    overlap_at_1            REAL,
    overlap_at_3            REAL,
    matched_kinds           TEXT,
    retrieved_session_ids   TEXT,
    latency_ms              INTEGER,
    cost_usd                REAL,
    is_in_gold_subset       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_eval_cases_run ON eval_cases(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_cases_gold ON eval_cases(is_in_gold_subset);
`;
