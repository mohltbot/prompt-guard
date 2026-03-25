# Project Context

## Overview
prompt-guard-cli is a context-aware prompt enhancement tool for AI coding agents. It reads project documentation files (PROJECT.md, CONTEXT.md, etc.) and automatically injects relevant context into prompts before sending them to Claude, Cursor, or other AI coding agents.

## Problem Solved
Developers waste time with generic AI responses because the AI lacks project context. prompt-guard-cli bridges this gap by ensuring every prompt includes relevant project details, coding standards, and constraints.

## Tech Stack
- **Language:** TypeScript 5.0+
- **Runtime:** Node.js 18+
- **Package Manager:** npm
- **Testing:** Jest 29+
- **Build:** TypeScript Compiler (tsc)

## Dependencies
- **chalk:** Terminal styling and colors
- **commander:** CLI argument parsing
- **glob:** File pattern matching

## Architecture

### Entry Points
- **CLI:** `bin/prompt-guard` — Main command-line interface
- **Library:** `dist/index.js` — Programmatic API

### Core Modules
- **src/index.ts** — Main PromptGuard class with check/enhance/init/config
- **src/smart-relevance.ts** — Context relevance scoring algorithm

### Key Features
1. **Prompt Checking:** 6 built-in checks (files, tests, criteria, constraints, local-env, context-window)
2. **Context Enhancement:** Auto-injects PROJECT.md, CONTEXT.md, AGENTS.md, SOUL.md
3. **Smart Truncation:** Respects token limits, includes most relevant context first
4. **Local Env Sanitization:** Strips absolute paths, API keys, machine-specific config
5. **Relevance Scoring:** Keyword-based matching to prioritize context files

### Distribution
- **npm package:** prompt-guard-cli
- **VS Code Extension:** vscode-extension/ (separate package)
- **Cursor Integration:** cursor-integration/cursor-guard.sh

## File Structure
```
prompt-guard/
├── bin/prompt-guard          # CLI entry point
├── src/
│   ├── index.ts              # Core library
│   └── smart-relevance.ts    # Relevance scoring
├── dist/                     # Compiled JavaScript
├── tests/                    # Jest test suite
├── vscode-extension/         # VS Code extension
├── cursor-integration/       # Cursor wrapper scripts
└── examples/                 # Usage examples
```

## Coding Conventions
- **Style:** ESLint recommended + TypeScript strict
- **Naming:** camelCase for functions/variables, PascalCase for classes
- **Comments:** JSDoc for public APIs, inline for complex logic
- **Error Handling:** Try-catch with meaningful error messages
- **Logging:** Use chalk for colored terminal output

## Constraints
- **Performance:** <100ms for prompt checking, <500ms for enhancement
- **Bundle Size:** Keep npm package under 100KB
- **Compatibility:** Node.js 18+, macOS/Linux/Windows
- **Security:** Never log or expose API keys, tokens, or credentials
- **Privacy:** All processing local — no data sent to external servers

## Testing Requirements
- **Unit Tests:** All public methods
- **Coverage:** 80% minimum
- **Integration:** CLI commands, file I/O, config loading
- **Edge Cases:** Empty prompts, large files, missing context files

## Performance Targets
- Prompt check: <50ms
- Context enhancement: <200ms
- Memory usage: <50MB for typical projects

## Release Process
1. Update version in package.json
2. Run tests: `npm test`
3. Build: `npm run build`
4. Publish: `npm publish --access public`
5. Tag release on GitHub

## Future Roadmap
- VS Code extension marketplace publish
- Semantic context matching (embeddings)
- Team-shared context templates
- CI/CD integration
