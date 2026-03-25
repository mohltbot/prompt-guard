# Example: Before and After

## Before (Generic Prompt)

**User types:**
```bash
claude "refactor the auth system"
```

**AI receives:**
```
refactor the auth system
```

**AI produces:**
- Generic auth middleware
- Assumes Express.js
- No tests
- Breaks existing session handling

## After (Context-Enhanced)

**User types:**
```bash
prompt-guard enhance "refactor the auth system" | claude
```

**AI receives:**
```markdown
## Project Context

### From PROJECT.md:
- Tech Stack: Node.js, Fastify, PostgreSQL
- Auth: JWT with refresh tokens, 24h expiry
- Current setup: Custom auth in src/auth/
- Testing: Jest with 90% coverage requirement

### From CONTEXT.md:
- Always write tests for new features
- Don't break existing APIs without versioning
- Keep functions under 50 lines
- Use dependency injection for testability

## User Request

refactor the auth system

## Instructions
- Consider the project context above
- Follow any patterns or conventions mentioned
- If tests are mentioned in context, include them
- Respect any constraints from the context files
```

**AI produces:**
- Fastify-compatible auth plugin
- Maintains existing session API
- Comprehensive test suite
- Clean dependency injection

## The Difference

| Aspect | Without Context | With Context |
|--------|----------------|--------------|
| Framework | Wrong (Express) | Right (Fastify) |
| Tests | None | Full coverage |
| API Compatibility | Broken | Preserved |
| Code Quality | Generic | Project-specific |
| Time to Merge | 3 rounds of fixes | 1 round |

## Real Example

See `examples/real-world/` for actual before/after prompts from production projects.
