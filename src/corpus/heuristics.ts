/**
 * Heuristic taggers used at ingestion time AND by the existing rule-based checks.
 * Single source of truth for "does this prompt mention X" patterns.
 *
 * Kept separate from `src/index.ts` so MVP-2 (Check refactor) can pull from here
 * without circular deps.
 */

const FILE_PATTERNS = [
  /\b\w+\.(js|ts|jsx|tsx|py|go|rs|java|cpp|c|h|md|json|yaml|yml|toml|sql|sh)\b/,
  /\b(src|lib|app|components|utils|tests?|api|pages|server|client)\/[\w/-]+/,
  /\*\.[\w]+/,
  /\b(file|files|path|paths)\b/i,
];

const TEST_PATTERNS = [
  /\btest(s)?\b/i,
  /\bspec\b/i,
  /\bvalidation\b/i,
  /\bverify\b/i,
  /\bshould\s+\w+/i,
  /\bmust\s+\w+/i,
];

const CRITERIA_PATTERNS = [
  /\b(should|must|needs? to)\s+\w+/i,
  /\bgoal\b/i,
  /\bsuccess\b/i,
  /\bcriteria\b/i,
  /\bhandle\s+\d+/i,
  /\bpass\b/i,
];

const CONSTRAINT_PATTERNS = [
  /\b(don't|do not|never)\s+\w+/i,
  /\bavoid\b/i,
  /\blimit\b/i,
  /\bmax\b/i,
  /\bconstraint\b/i,
  /\bwithout\s+breaking\b/i,
];

const LOCAL_ENV_PATTERNS = [
  /\/Users\/\w+|\/home\/\w+|C:\\Users\\\w+/,
  /localhost:\d{4,5}/,
  /\b(my mac|my laptop|my machine|my computer)\b/i,
  /\/[a-z]+\/[a-z]+\/[^\s]+\.(js|ts|json)/i,
];

const SHAPE_TOKENS = /\b(type|interface|schema|columns|fields|model|enum)\b/i;
const UI_TOKENS = /\b(color|colour|spacing|font|alignment|layout|padding|margin|hover|click|button|modal|tooltip)\b/i;

export interface PromptTags {
  has_files: boolean;
  has_tests: boolean;
  has_criteria: boolean;
  has_constraints: boolean;
  has_local_env: boolean;
  has_shape: boolean;
  has_ui: boolean;
}

export function tagPrompt(text: string): PromptTags {
  return {
    has_files: FILE_PATTERNS.some(p => p.test(text)),
    has_tests: TEST_PATTERNS.some(p => p.test(text)),
    has_criteria: CRITERIA_PATTERNS.some(p => p.test(text)),
    has_constraints: CONSTRAINT_PATTERNS.some(p => p.test(text)),
    has_local_env: LOCAL_ENV_PATTERNS.some(p => p.test(text)),
    has_shape: SHAPE_TOKENS.test(text),
    has_ui: UI_TOKENS.test(text),
  };
}

export function detectLocalEnvIssues(text: string): string[] {
  const issues: string[] = [];
  if (/\/Users\/\w+|\/home\/\w+|C:\\Users\\\w+/.test(text)) issues.push('absolute paths (/Users/..., /home/...)');
  if (/localhost:\d{4,5}/.test(text)) issues.push('localhost ports');
  if (/\b(my mac|my laptop|my machine|my computer)\b/i.test(text)) issues.push('machine-specific references');
  if (/\/[a-z]+\/[a-z]+\/[^\s]+\.(js|ts|json)/i.test(text)) issues.push('absolute file paths');
  return issues;
}
