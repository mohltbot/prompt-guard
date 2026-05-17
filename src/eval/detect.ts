/**
 * Per-case instrumentation flags for the eval harness.
 * Patterns live in patterns.json for easy extension without rebuild.
 */

import patterns from './patterns.json';

const vagueVerbRe = new RegExp(patterns.vagueVerbs.regex, 'i');
const verbDisamRegexes = patterns.verbDisambiguationQuestion.regexes.map(r => new RegExp(r, 'i'));
const liveRe = new RegExp(patterns.liveVsLocalQuestion.liveSignals, 'i');
const localRe = new RegExp(patterns.liveVsLocalQuestion.localSignals, 'i');

/** True if the prompt's main verb is in the vague-verb list. */
export function detectVagueVerb(prompt: string): boolean {
  return vagueVerbRe.test(prompt);
}

/** True if a question text shape suggests it's a verb-disambiguation. */
export function detectVerbDisambiguationQuestion(text: string): boolean {
  return verbDisamRegexes.some(re => re.test(text));
}

/** True if Q2 asks about live deployment vs local file. */
export function detectLiveVsLocalQ2(questions: { text: string }[]): boolean {
  if (questions.length < 2) return false;
  const q2 = questions[1].text;
  return liveRe.test(q2) && localRe.test(q2);
}
