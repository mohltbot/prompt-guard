# Prompt Guard

> Context-aware prompt enhancement for AI coding agents

Prompt Guard reads your project's `.md` files and automatically injects relevant context into your prompts before sending them to Claude, Cursor, or any AI coding agent.

## The Problem

You type: `"refactor the auth system"`

The AI doesn't know:
- You're using JWT tokens
- You have a PostgreSQL database
- Your team requires 90% test coverage
- You can't break the existing API

**Result:** Generic code that doesn't fit your project.

## The Solution

Prompt Guard reads `PROJECT.md`, `CONTEXT.md`, `AGENTS.md` and enhances your prompt:

```
## Project Context

### From PROJECT.md:
- Tech Stack: Node.js, Express, PostgreSQL
- Auth: JWT tokens with 24h expiry
- Testing: Jest with 90% coverage requirement

### From CONTEXT.md:
- Always write tests for new features
- Don't break existing APIs without versioning
- Keep functions under 50 lines

## User Request

refactor the auth system

## Instructions
- Consider the project context above
- Follow any patterns or conventions mentioned
- If tests are mentioned in context, include them
- Respect any constraints from the context files
```

**Result:** Code that actually fits your project.

## Installation

```bash
npm install -g prompt-guard
```

## Quick Start

### 1. Initialize in your project

```bash
cd your-project
prompt-guard init
```

This creates:
- `PROJECT.md` — Your project overview, tech stack, architecture
- `CONTEXT.md` — Coding conventions, patterns, constraints

### 2. Edit the context files

Fill in `PROJECT.md` and `CONTEXT.md` with your project details.

### 3. Check your prompts

```bash
prompt-guard check "add user login"
```

Output:
```
⚠ No specific files mentioned
  → Add file paths like "src/auth/**" or "update login.js"

⚠ No tests or validation criteria mentioned
  → Add "include tests" or "should handle X cases"

ℹ No constraints mentioned
  → Consider adding "don't break existing API" or "keep under 100 lines"
```

### 4. Enhance and send

```bash
prompt-guard enhance "add user login" | claude
```

## Commands

- `prompt-guard init` — Create context files in current project
- `prompt-guard check <prompt>` — Check for missing context
- `prompt-guard enhance <prompt>` — Enhance with context
- `prompt-guard config` — Show current configuration

## Shell Integration

Add to your `.zshrc` or `.bashrc`:

```bash
# Auto-enhance all claude commands
alias claude='prompt-guard enhance'

# Or check before sending
claude() {
  prompt-guard check "$*"
  read -q "REPLY?Continue? [y/N] "
  echo
  if [[ $REPLY == "y" ]]; then
    command claude "$(prompt-guard enhance "$*")"
  fi
}
```

## Context Files

Prompt Guard looks for these files in your project root:

| File | Purpose |
|------|---------|
| `PROJECT.md` | Tech stack, architecture, entry points |
| `CONTEXT.md` | Coding conventions, patterns, constraints |
| `AGENTS.md` | Agent-specific instructions |
| `SOUL.md` | Project philosophy, values |
| `README.md` | Fallback for basic context |

## Configuration

Create `.prompt-guard.json` in your project root:

```json
{
  "contextFiles": ["PROJECT.md", "CONTEXT.md"],
  "enabledChecks": ["files-mentioned", "tests-mentioned"],
  "autoInject": true,
  "confirmBeforeSend": true
}
```

## How It Works

1. **Load Context** — Reads `.md` files from project root
2. **Parse Prompt** — Analyzes your prompt for completeness
3. **Check** — Identifies missing context (files, tests, criteria)
4. **Enhance** — Injects relevant context into the prompt
5. **Send** — Outputs enhanced prompt to your AI agent

## Privacy

- Only reads files you specify
- No data sent to external servers
- Context stays local to your machine
- No AI calls made by Prompt Guard itself

## Why This Matters

**Without context:**
```
User: "add caching"
AI: Generic Redis setup that doesn't fit your stack
```

**With context:**
```
Context: "Using Node.js, PostgreSQL, already have Redis for sessions"
User: "add caching"
AI: Extends existing Redis setup, adds cache layer to DB queries
```

## Roadmap

**Current (v0.1.0):**
- [x] CLI tool with check/enhance commands
- [x] Context file loading (PROJECT.md, CONTEXT.md, etc.)
- [x] Config file support (.prompt-guard.json)
- [x] Local environment sanitization
- [x] Context window protection with auto-truncation
- [x] Token estimation
- [x] 6 built-in checks (files, tests, criteria, constraints, local-env, context-window)

**Coming Soon:**
- [ ] VS Code extension
- [ ] Cursor/Copilot integration
- [ ] Smart context relevance scoring
- [ ] Team-shared context templates

## License

MIT

## Contributing

PRs welcome! This is a weekend project that grew out of frustration with generic AI code.
