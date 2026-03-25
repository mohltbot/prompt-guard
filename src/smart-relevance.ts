import { PromptGuard } from './index';

interface ScoredContext {
  fileName: string;
  content: string;
  score: number;
  matchedKeywords: string[];
}

/**
 * Smart context relevance scoring using keyword matching
 * Future: Could use embeddings for semantic similarity
 */
export class SmartRelevance {
  private guard: PromptGuard;

  constructor(guard: PromptGuard) {
    this.guard = guard;
  }

  /**
   * Score context files based on relevance to the prompt
   */
  async scoreContext(prompt: string, projectPath: string = process.cwd()): Promise<ScoredContext[]> {
    // Load all context files
    const contextFiles = await this.guard.loadContext(projectPath);
    
    // Extract keywords from prompt
    const promptKeywords = this.extractKeywords(prompt);
    
    // Score each file
    const scored: ScoredContext[] = contextFiles.map(file => {
      const fileKeywords = this.extractKeywords(file.content);
      const matchedKeywords = this.findMatches(promptKeywords, fileKeywords);
      
      // Calculate score based on:
      // 1. Keyword overlap (50%)
      // 2. File relevance weight (30%)
      // 3. Content density (20%)
      const keywordScore = matchedKeywords.length / Math.max(promptKeywords.length, 1);
      const relevanceWeight = file.relevance;
      const densityScore = Math.min(file.content.length / 5000, 1); // Normalize to 0-1
      
      const score = (keywordScore * 0.5) + (relevanceWeight * 0.3) + (densityScore * 0.2);
      
      return {
        fileName: file.name,
        content: file.content,
        score,
        matchedKeywords
      };
    });
    
    // Sort by score descending
    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * Extract keywords from text
   */
  private extractKeywords(text: string): string[] {
    // Convert to lowercase and extract words
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3); // Filter out short words
    
    // Remove common stop words
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use', 'with', 'have', 'this', 'will', 'your', 'from', 'they', 'know', 'want', 'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come', 'here', 'just', 'like', 'long', 'make', 'many', 'over', 'such', 'take', 'than', 'them', 'well', 'were'
    ]);
    
    // Filter stop words and get unique keywords
    const keywords = [...new Set(words)].filter(word => !stopWords.has(word));
    
    return keywords;
  }

  /**
   * Find matching keywords between two sets
   */
  private findMatches(promptKeywords: string[], fileKeywords: string[]): string[] {
    const fileSet = new Set(fileKeywords);
    return promptKeywords.filter(kw => fileSet.has(kw));
  }

  /**
   * Get the top N most relevant context files
   */
  async getTopContext(
    prompt: string, 
    projectPath: string = process.cwd(),
    topN: number = 3
  ): Promise<ScoredContext[]> {
    const scored = await this.scoreContext(prompt, projectPath);
    return scored.slice(0, topN);
  }

  /**
   * Generate a relevance report for debugging
   */
  async generateRelevanceReport(prompt: string, projectPath: string = process.cwd()): Promise<string> {
    const scored = await this.scoreContext(prompt, projectPath);
    
    let report = '# Context Relevance Report\n\n';
    report += `Prompt: "${prompt}"\n\n`;
    report += '## File Rankings\n\n';
    
    for (let i = 0; i < scored.length; i++) {
      const ctx = scored[i];
      report += `${i + 1}. **${ctx.fileName}** (score: ${ctx.score.toFixed(2)})\n`;
      report += `   - Matched keywords: ${ctx.matchedKeywords.join(', ') || 'none'}\n`;
      report += `   - Content length: ${ctx.content.length} chars\n\n`;
    }
    
    return report;
  }
}