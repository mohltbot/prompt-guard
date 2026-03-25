import { PromptGuard } from '../src/index';

describe('PromptGuard', () => {
  let guard: PromptGuard;

  beforeEach(() => {
    guard = new PromptGuard({
      contextFiles: [], // Don't load files for unit tests
      maxContextTokens: 1000
    });
  });

  describe('check', () => {
    it('should warn about missing file references', async () => {
      const results = await guard.check('refactor auth');
      const fileWarning = results.find(r => r.message.includes('files'));
      expect(fileWarning).toBeDefined();
      expect(fileWarning?.type).toBe('warning');
    });

    it('should warn about missing test references', async () => {
      const results = await guard.check('add login');
      const testWarning = results.find(r => r.message.includes('test'));
      expect(testWarning).toBeDefined();
    });

    it('should warn about local environment references', async () => {
      const results = await guard.check('fix bug in /Users/mohammed/code');
      const localWarning = results.find(r => r.message.includes('local environment'));
      expect(localWarning).toBeDefined();
    });

    it('should pass for complete prompts', async () => {
      const results = await guard.check('update src/auth/login.js to handle OAuth, include tests, should not break existing API');
      const warnings = results.filter(r => r.type === 'warning');
      expect(warnings.length).toBeLessThan(3); // Should have fewer warnings
    });
  });

  describe('token estimation', () => {
    it('should estimate tokens correctly', () => {
      // Access private method through any cast
      const estimate = (guard as any).estimateTokens('hello world');
      expect(estimate).toBe(3); // 11 chars / 4 = 2.75 -> 3
    });
  });

  describe('sanitizeLocalEnv', () => {
    it('should remove absolute paths', () => {
      const sanitize = (guard as any).sanitizeLocalEnv.bind(guard);
      const result = sanitize('path is /Users/mohammed/project');
      expect(result).toContain('<USER_HOME>');
      expect(result).not.toContain('/Users/mohammed');
    });

    it('should redact API keys', () => {
      const sanitize = (guard as any).sanitizeLocalEnv.bind(guard);
      const result = sanitize('api_key=sk-12345abc');
      expect(result).toContain('<REDACTED>');
      expect(result).not.toContain('sk-12345abc');
    });
  });
});