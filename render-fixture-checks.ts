/** Pure checks used by render-fixture and its dataset-independent tests. */
import type { Phase, TimelineEntry } from './core.js';

export interface Expectation {
  label: string;
  fixture: string;
  id: string;
  phase: Phase;
  segment: number;
  want: string;
}
export type FixtureEntry = Pick<TimelineEntry, 'id' | 'phase' | 'segmentIndex' | 'displayDateISO'> & { fixture: string };
export interface CheckResult extends Expectation {
  verdict: 'PASS' | 'FAIL' | 'ABSENT' | 'DUPLICATE';
  shows: string;
}

/** An occurrence is identified by dataset row ID, fixture, phase and segment. */
export function checkOccurrences(expectations: Expectation[], entries: FixtureEntry[]): CheckResult[] {
  return expectations.map((expectation) => {
    const hits = entries.filter((e) => e.fixture === expectation.fixture && e.id === expectation.id &&
      e.phase === expectation.phase && e.segmentIndex === expectation.segment);
    let verdict: CheckResult['verdict'];
    if (hits.length === 0) verdict = 'ABSENT';
    else if (hits.length > 1) verdict = 'DUPLICATE';
    else verdict = hits[0].displayDateISO === expectation.want ? 'PASS' : 'FAIL';
    return { ...expectation, verdict, shows: hits.map((e) => e.displayDateISO).join(', ') || '-' };
  });
}

const PHASE_VERB = /\b(begins?|began|beginning|starts?|started|ends?|ended|ending|opens?|opened|closes?|closed)\s*$/i;

/** Check the actual markdown card format: `- **date** — title (phase)`. */
export function findDoubledPhaseLines(markdown: string): string[] {
  return markdown.split('\n').filter((line) => {
    const match = line.match(/^- \*\*.*?\*\*\s+—\s+(.*?)\s+\((begins|ends|ongoing)\)\s*$/i);
    return Boolean(match && PHASE_VERB.test(match[1]));
  });
}
