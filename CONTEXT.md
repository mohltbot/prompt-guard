# Coding Context

## Patterns to Follow

### TypeScript Best Practices
- Enable `strict: true` in tsconfig.json
- Use explicit return types on public functions
- Prefer `interface` over `type` for object shapes
- Use `readonly` for immutable properties
- Avoid `any` — use `unknown` with type guards

### Code Organization
- One class per file (main classes)
- Group related utility functions
- Keep functions under 50 lines
- Maximum 3 levels of nesting
- Early returns over deep conditionals

### Error Handling
```typescript
// Good
try {
  const result = await operation();
  return result;
} catch (error) {
  if (error instanceof SpecificError) {
    handleSpecific(error);
  } else {
    throw new Error(`Operation failed: ${error.message}`);
  }
}

// Bad — swallowing errors
try {
  return await operation();
} catch (e) {
  return null;
}
```

### Async Patterns
- Always use `async/await`, avoid raw Promises
- Handle rejections at call site
- Use `Promise.all()` for parallel operations
- Set timeouts for external operations

### CLI Output
- Use chalk for colors: `chalk.green('✓')`, `chalk.red('✗')`, `chalk.yellow('⚠')`
- Consistent spacing: empty line before/after sections
- Progress indicators for long operations
- Clear error messages with suggestions

### Testing
- Describe blocks for feature organization
- One assertion per test (when possible)
- Mock file system, don't write real files in tests
- Test edge cases: empty, null, very large inputs

```typescript
// Good test structure
describe('PromptGuard', () => {
  describe('check', () => {
    it('should warn about missing files', async () => {
      const results = await guard.check('refactor auth');
      expect(results.some(r => r.message.includes('files'))).toBe(true);
    });
  });
});
```

## Things to Avoid

### Security
- ❌ Never log API keys, tokens, or credentials
- ❌ Don't include node_modules in npm package
- ❌ No eval() or dynamic code execution
- ❌ Don't make network requests without user consent

### Performance
- ❌ Don't read large files into memory (>1MB)
- ❌ Avoid synchronous file operations in async functions
- ❌ Don't use regex for complex parsing (use parsers)
- ❌ No infinite loops or unbounded recursion

### Code Smells
- ❌ Deep nesting (>3 levels)
- ❌ Functions with >5 parameters
- ❌ Magic numbers without constants
- ❌ Duplicate code — extract to functions
- ❌ Comments that explain what (not why)

## Documentation Standards

### JSDoc for Public APIs
```typescript
/**
 * Check a prompt for missing context
 * @param promptText - The prompt to analyze
 * @returns Array of check results with warnings/errors
 * @example
 * const results = await guard.check('refactor auth');
 * // [{ type: 'warning', message: 'No files mentioned', ... }]
 */
async check(promptText: string): Promise<CheckResult[]> { }
```

### README Updates
- Keep installation instructions current
- Update examples when API changes
- Document breaking changes in CHANGELOG
- Include troubleshooting section

## Git Workflow
- Feature branches: `feature/description`
- Bug fixes: `fix/description`
- Commit messages: imperative mood ("Add feature" not "Added feature")
- Squash commits before merging to main
- Tag releases: `v0.1.0`

## Code Review Checklist
- [ ] Tests pass: `npm test`
- [ ] Builds successfully: `npm run build`
- [ ] No TypeScript errors
- [ ] No linting errors
- [ ] Documentation updated
- [ ] CHANGELOG updated for user-facing changes
- [ ] Version bumped appropriately

## Dependencies
- **Add sparingly:** Each dependency is maintenance burden
- **Prefer native:** Use Node.js built-ins when possible
- **Check licenses:** MIT/Apache/BSD only
- **Keep updated:** Monthly dependency updates

## Performance Optimization
- Lazy load heavy modules
- Cache file reads (but invalidate on change)
- Use streams for large files
- Profile before optimizing

## Accessibility (CLI)
- Clear error messages
- Suggest fixes, don't just complain
- Respect NO_COLOR environment variable
- Work in CI environments (no TTY)
