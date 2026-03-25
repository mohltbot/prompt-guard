import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import chalk from 'chalk';

interface ContextFile {
  name: string;
  content: string;
  relevance: number;
}

interface CheckResult {
  type: 'warning' | 'error' | 'info';
  message: string;
  suggestion?: string;
}

interface Config {
  contextFiles: string[];
  enabledChecks: string[];
  autoInject: boolean;
  confirmBeforeSend: boolean;
  maxContextTokens: number; // Approximate token limit for context
  modelLimits: Record<string, number>; // Model-specific limits
}

export class PromptGuard {
  private config: Config;
  private contextCache: Map<string, string> = new Map();

  constructor(config?: Partial<Config>) {
    this.config = {
      contextFiles: ['PROJECT.md', 'SOUL.md', 'AGENTS.md', 'CONTEXT.md', 'README.md'],
      enabledChecks: ['files-mentioned', 'tests-mentioned', 'success-criteria', 'constraints'],
      autoInject: true,
      confirmBeforeSend: true,
      maxContextTokens: 4000, // Default: leave room for response
      modelLimits: {
        'claude': 100000,
        'claude-opus': 200000,
        'gpt-4': 8000,
        'gpt-4-turbo': 128000,
        'cursor': 8000
      },
      ...config
    };
  }

  /**
   * Load context from .md files in project root
   * Filters out local environment specifics to prevent overfitting
   */
  async loadContext(projectPath: string = process.cwd()): Promise<ContextFile[]> {
    const contextFiles: ContextFile[] = [];

    for (const fileName of this.config.contextFiles) {
      const filePath = path.join(projectPath, fileName);

      if (fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, 'utf-8');

        // Sanitize content to remove local environment specifics
        content = this.sanitizeLocalEnv(content);

        this.contextCache.set(fileName, content);

        contextFiles.push({
          name: fileName,
          content: this.truncateContent(content, 2000),
          relevance: this.calculateRelevance(fileName)
        });
      }
    }

    return contextFiles;
  }

  /**
   * Remove local environment specifics that cause overfitting
   */
  private sanitizeLocalEnv(content: string): string {
    // Remove absolute paths
    content = content.replace(/\/Users\/\w+|\/home\/\w+|C:\\Users\\\w+/g, '<USER_HOME>');

    // Remove local ports (keep common ones like 3000, 8080 as examples)
    content = content.replace(/localhost:\d{4,5}/g, (match) => {
      const port = parseInt(match.split(':')[1]);
      // Keep common ports as examples, redact others
      if ([3000, 3001, 8080, 8000].includes(port)) {
        return match;
      }
      return 'localhost:<PORT>';
    });

    // Remove API keys and tokens
    content = content.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*['"\w-]+/gi, '$1: <REDACTED>');

    // Remove local file paths but keep relative ones
    content = content.replace(/\/\w+\/\w+\/[^\s]+\.(js|ts|json|md)/g, (match) => {
      // Keep relative paths (starting with ./ or ../ or src/)
      if (match.startsWith('./') || match.startsWith('../') || match.startsWith('src/')) {
        return match;
      }
      return '<LOCAL_PATH>';
    });

    // Remove machine-specific config
    content = content.replace(/(hostname|computer name|machine|device):\s*\w+/gi, '$1: <MACHINE>');

    return content;
  }

  /**
   * Check a prompt for missing context
   */
  async check(promptText: string): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    
    // Check 1: Files mentioned
    if (!this.hasFileReferences(promptText)) {
      results.push({
        type: 'warning',
        message: 'No specific files mentioned',
        suggestion: 'Add file paths like "src/auth/**" or "update login.js"'
      });
    }
    
    // Check 2: Tests mentioned
    if (!this.hasTestReferences(promptText)) {
      results.push({
        type: 'warning',
        message: 'No tests or validation criteria mentioned',
        suggestion: 'Add "include tests" or "should handle X cases"'
      });
    }
    
    // Check 3: Success criteria
    if (!this.hasSuccessCriteria(promptText)) {
      results.push({
        type: 'warning',
        message: 'No clear success criteria',
        suggestion: 'Add "should pass all tests" or "must handle 10k req/s"'
      });
    }
    
    // Check 4: Constraints
    if (!this.hasConstraints(promptText)) {
      results.push({
        type: 'info',
        message: 'No constraints mentioned',
        suggestion: 'Consider adding "don\'t break existing API" or "keep under 100 lines"'
      });
    }

    // Check 5: Local environment references (overfitting risk)
    const localEnvIssues = this.checkLocalEnvReferences(promptText);
    if (localEnvIssues.length > 0) {
      results.push({
        type: 'warning',
        message: 'Prompt contains local environment references',
        suggestion: `Remove: ${localEnvIssues.join(', ')}. Use relative paths and generic config instead.`
      });
    }

    // Check 6: Context window size
    const estimatedTokens = this.estimateTokens(promptText);
    const contextFiles = await this.loadContext();
    const contextTokens = contextFiles.reduce((sum, f) => sum + this.estimateTokens(f.content), 0);
    const totalTokens = estimatedTokens + contextTokens;

    if (totalTokens > this.config.maxContextTokens) {
      results.push({
        type: 'error',
        message: `Context window will be exceeded (~${totalTokens} tokens)`,
        suggestion: `Reduce context files or truncate content. Current: ${contextFiles.length} files, ${contextTokens} tokens of context. Try removing less relevant .md files.`
      });
    } else if (totalTokens > this.config.maxContextTokens * 0.8) {
      results.push({
        type: 'warning',
        message: `Approaching context limit (~${totalTokens} tokens)`,
        suggestion: 'Consider truncating context files or removing less relevant ones. Leave room for AI response.'
      });
    }

    return results;
  }

  /**
   * Enhance prompt with context from .md files
   * Respects context window limits
   */
  async enhance(promptText: string): Promise<string> {
    let contextFiles = await this.loadContext();

    if (contextFiles.length === 0) {
      console.log(chalk.yellow('No context files found. Run `prompt-guard init` to create them.'));
      return promptText;
    }

    // Check context window and truncate if needed
    const promptTokens = this.estimateTokens(promptText);
    const instructionsTokens = 100; // Approximate
    let availableTokens = this.config.maxContextTokens - promptTokens - instructionsTokens;

    // Sort by relevance and truncate if needed
    contextFiles.sort((a, b) => b.relevance - a.relevance);

    let totalContextTokens = 0;
    const includedFiles: ContextFile[] = [];

    for (const file of contextFiles) {
      const fileTokens = this.estimateTokens(file.content);

      if (totalContextTokens + fileTokens <= availableTokens) {
        includedFiles.push(file);
        totalContextTokens += fileTokens;
      } else {
        // Try to truncate this file to fit
        const remainingTokens = availableTokens - totalContextTokens;
        if (remainingTokens > 500) { // Only include if we can fit meaningful content
          const truncatedContent = this.truncateContent(file.content, remainingTokens * 4);
          includedFiles.push({
            ...file,
            content: truncatedContent + '\n... (truncated due to context limit)'
          });
          totalContextTokens += remainingTokens;
        }
        break;
      }
    }

    if (includedFiles.length < contextFiles.length) {
      console.log(chalk.yellow(`⚠ Context truncated: using ${includedFiles.length}/${contextFiles.length} files to fit context window`));
    }

    let enhancedPrompt = '';

    // Add context header
    enhancedPrompt += `## Project Context\n\n`;

    for (const file of includedFiles) {
      enhancedPrompt += `### From ${file.name}:\n${file.content}\n\n`;
    }

    // Add the original prompt
    enhancedPrompt += `## User Request\n\n${promptText}\n\n`;

    // Add instructions for the AI
    enhancedPrompt += `## Instructions\n\n`;
    enhancedPrompt += `- Consider the project context above\n`;
    enhancedPrompt += `- Follow any patterns or conventions mentioned\n`;
    enhancedPrompt += `- If tests are mentioned in context, include them\n`;
    enhancedPrompt += `- Respect any constraints from the context files\n`;

    return enhancedPrompt;
  }

  /**
   * Display check results with formatting
   */
  displayResults(results: CheckResult[]): void {
    if (results.length === 0) {
      console.log(chalk.green('✓ All checks passed!'));
      return;
    }
    
    console.log(chalk.bold('\nPrompt Analysis:\n'));
    
    for (const result of results) {
      const icon = result.type === 'error' ? '✗' : result.type === 'warning' ? '⚠' : 'ℹ';
      const color = result.type === 'error' ? chalk.red : result.type === 'warning' ? chalk.yellow : chalk.blue;
      
      console.log(color(`${icon} ${result.message}`));
      if (result.suggestion) {
        console.log(chalk.gray(`  → ${result.suggestion}`));
      }
    }
    
    console.log('');
  }

  /**
   * Initialize prompt-guard in current project
   */
  async init(): Promise<void> {
    const projectPath = process.cwd();
    
    console.log(chalk.bold('Initializing prompt-guard...\n'));
    
    // Create PROJECT.md template
    const projectMdPath = path.join(projectPath, 'PROJECT.md');
    if (!fs.existsSync(projectMdPath)) {
      fs.writeFileSync(projectMdPath, this.getProjectTemplate());
      console.log(chalk.green('✓ Created PROJECT.md'));
    } else {
      console.log(chalk.yellow('⚠ PROJECT.md already exists'));
    }
    
    // Create CONTEXT.md template
    const contextMdPath = path.join(projectPath, 'CONTEXT.md');
    if (!fs.existsSync(contextMdPath)) {
      fs.writeFileSync(contextMdPath, this.getContextTemplate());
      console.log(chalk.green('✓ Created CONTEXT.md'));
    } else {
      console.log(chalk.yellow('⚠ CONTEXT.md already exists'));
    }
    
    console.log(chalk.bold('\nNext steps:'));
    console.log('1. Edit PROJECT.md with your project details');
    console.log('2. Edit CONTEXT.md with coding conventions');
    console.log('3. Run `prompt-guard check "your prompt"` to test');
  }

  /**
   * Show current configuration
   */
  showConfig(): void {
    console.log(chalk.bold('Prompt Guard Configuration:\n'));
    console.log('Context files:', this.config.contextFiles.join(', '));
    console.log('Enabled checks:', this.config.enabledChecks.join(', '));
    console.log('Auto-inject:', this.config.autoInject);
    console.log('Confirm before send:', this.config.confirmBeforeSend);
  }

  // Helper methods
  private hasFileReferences(prompt: string): boolean {
    const filePatterns = [
      /\b\w+\.(js|ts|jsx|tsx|py|go|rs|java|cpp|c|h)\b/,
      /\b(src|lib|app|components|utils|tests?)\/[\w\/]+/,
      /\*\.[\w]+/,  // *.js, *.ts, etc.
      /\b(file|files|path|paths)\b/i
    ];
    return filePatterns.some(pattern => pattern.test(prompt));
  }

  private hasTestReferences(prompt: string): boolean {
    const testPatterns = [
      /\btest(s)?\b/i,
      /\bspec\b/i,
      /\bvalidation\b/i,
      /\bverify\b/i,
      /\bshould\s+\w+/i,
      /\bmust\s+\w+/i
    ];
    return testPatterns.some(pattern => pattern.test(prompt));
  }

  private hasSuccessCriteria(prompt: string): boolean {
    const criteriaPatterns = [
      /\b(should|must|needs? to)\s+\w+/i,
      /\bgoal\b/i,
      /\bsuccess\b/i,
      /\bcriteria\b/i,
      /\bhandle\s+\d+/i,
      /\bpass\b/i
    ];
    return criteriaPatterns.some(pattern => pattern.test(prompt));
  }

  private hasConstraints(prompt: string): boolean {
    const constraintPatterns = [
      /\b(don't|do not|never)\s+\w+/i,
      /\bavoid\b/i,
      /\blimit\b/i,
      /\bmax\b/i,
      /\bconstraint\b/i,
      /\bwithout\s+breaking\b/i
    ];
    return constraintPatterns.some(pattern => pattern.test(prompt));
  }

  private checkLocalEnvReferences(prompt: string): string[] {
    const issues: string[] = [];

    // Check for absolute paths
    if (/\/Users\/\w+|\/home\/\w+|C:\\Users\\\w+/.test(prompt)) {
      issues.push('absolute paths (/Users/..., /home/...)');
    }

    // Check for local ports
    if (/localhost:\d{4,5}/.test(prompt)) {
      issues.push('localhost ports');
    }

    // Check for machine-specific terms
    if (/\b(my mac|my laptop|my machine|my computer)\b/i.test(prompt)) {
      issues.push('machine-specific references');
    }

    // Check for local file paths that aren't relative
    if (/\/[a-z]+\/[a-z]+\/[^\s]+\.(js|ts|json)/i.test(prompt)) {
      issues.push('absolute file paths');
    }

    return issues;
  }

  private calculateRelevance(fileName: string): number {
    const relevanceMap: Record<string, number> = {
      'PROJECT.md': 1.0,
      'CONTEXT.md': 0.9,
      'AGENTS.md': 0.8,
      'SOUL.md': 0.7,
      'README.md': 0.6
    };
    return relevanceMap[fileName] || 0.5;
  }

  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '\n... (truncated)';
  }

  /**
   * Estimate token count (rough approximation: ~4 chars per token)
   */
  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
  }

  private getProjectTemplate(): string {
    return `# Project Context

## Overview
Brief description of what this project does.

## Tech Stack
- Language: 
- Framework: 
- Database: 
- Key Dependencies: 

## Architecture
- Main entry point: 
- Core modules: 
- Testing framework: 

## Coding Conventions
- Style guide: 
- Naming conventions: 
- File organization: 

## Constraints
- Performance requirements: 
- Compatibility requirements: 
- Security considerations: 
`;
  }

  private getContextTemplate(): string {
    return `# Coding Context

## Patterns to Follow
- Always write tests for new features
- Use TypeScript strict mode
- Prefer functional components
- Keep functions under 50 lines

## Things to Avoid
- Don't use any types
- Don't skip error handling
- Don't break existing APIs without versioning

## Testing Requirements
- Unit tests for utilities
- Integration tests for APIs
- E2E tests for critical paths

## Performance Targets
- Page load under 2 seconds
- API response under 200ms
- Bundle size under 100KB
`;
  }
}