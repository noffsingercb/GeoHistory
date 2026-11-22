import assert from 'node:assert/strict';
import test from 'node:test';
import { checkOccurrences, findDoubledPhaseLines, type Expectation, type FixtureEntry } from './render-fixture-checks.js';

const begins: Expectation = { label: 'War', fixture: 'b', id: 'Q1', phase: 'begins', segment: 1, want: '1756-01-01' };
const ends: Expectation = { ...begins, phase: 'ends', segment: 2, want: '1763-12-31' };
const row = (e: Expectation): FixtureEntry => ({ fixture: e.fixture, id: e.id, phase: e.phase, segmentIndex: e.segment, displayDateISO: e.want });

test('separate phases and segments both pass, not compared to the same date', () => {
  assert.deepEqual(checkOccurrences([begins, ends], [row(begins), row(ends)]).map((r) => r.verdict), ['PASS', 'PASS']);
});

test('missing end is not hidden by a correct beginning', () => {
  assert.deepEqual(checkOccurrences([begins, ends], [row(begins)]).map((r) => r.verdict), ['PASS', 'ABSENT']);
});

test('wrong date, wrong segment and duplicate occurrence fail distinctly', () => {
  assert.equal(checkOccurrences([ends], [{ ...row(ends), displayDateISO: begins.want }])[0].verdict, 'FAIL');
  assert.equal(checkOccurrences([ends], [{ ...row(ends), segmentIndex: 1 }])[0].verdict, 'ABSENT');
  assert.equal(checkOccurrences([ends], [row(ends), row(ends)])[0].verdict, 'DUPLICATE');
});

test('a participant sibling cannot satisfy its parent, or another fixture', () => {
  assert.equal(checkOccurrences([begins], [{ ...row(begins), id: 'Q1#Q2' }])[0].verdict, 'ABSENT');
  assert.equal(checkOccurrences([begins], [{ ...row(begins), fixture: 'a' }])[0].verdict, 'ABSENT');
  assert.equal(checkOccurrences([{ ...begins, id: 'Q1#Q2' }], [{ ...row(begins), id: 'Q1#Q2' }])[0].verdict, 'PASS');
});

test('detects doubled phase verbs in rendered markdown, not unrelated text', () => {
  const doubled = '- **1760** — Industrial Revolution begins (begins)';
  const markdown = [doubled, '- **1760** — Industrial Revolution begins', '- **1760** — The War That Ended Wars (begins)', 'A prose line: begins (begins)'].join('\n');
  assert.deepEqual(findDoubledPhaseLines(markdown), [doubled]);
});
