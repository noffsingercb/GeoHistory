import assert from 'node:assert/strict';
import test from 'node:test';
import { missingPromotions } from './audit-universal-promotions';

test('reports missing promotions but excludes existing, deliberate inserts and non-universal rows', () => {
  const rows = [
    { Title: 'Present', Wikidata: 'Q1', Tier: 'universal' },
    { Title: 'Missing', Wikidata: 'Q2', Tier: 'universal', Action: 'promote' as const },
    { Title: 'Intentional insert', Wikidata: 'Q3', Tier: 'universal', Action: 'insert' as const },
    { Title: 'Ordinary', Wikidata: 'Q4' },
  ];
  assert.deepEqual(missingPromotions(rows, qid => qid === 'Q1'), [{ qid: 'Q2', title: 'Missing' }]);
});
