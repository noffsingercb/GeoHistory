/** Read-only audit of exact historical merge decisions, not a duplicate matcher. */
import Database from 'better-sqlite3'
import { pathToFileURL } from 'node:url'
import { VERDICTS } from './lib/reviewed-dupe-verdicts.js'
import { HISTORIC_AUTO_MERGES } from './lib/historic-auto-dupe-merges.js'
import type { MergeSpec } from './lib/dupe-apply.js'

type ReviewedPair = { survivor: string; donor: string; verdicts: string[] }

/** Only explicit member IDs are considered. Repeated verdicts for a pair are grouped. */
export function reviewedPairs(verdicts: readonly MergeSpec[]): ReviewedPair[] {
  const pairs = new Map<string, ReviewedPair>()
  const survivors = new Set(verdicts.map(v => v.survivorId).filter((id): id is string => Boolean(id)))
  for (const v of verdicts) {
    if (!v.id || !v.survivorId || !v.memberIds.includes(v.survivorId) || v.memberIds.length < 2 || new Set(v.memberIds).size !== v.memberIds.length) {
      throw new Error(`Invalid reviewed merge verdict: ${v.id || '(missing id)'}`)
    }
    for (const donor of v.memberIds) {
      if (donor === v.survivorId) continue
      if (survivors.has(donor)) throw new Error(`Contradictory verdict: ${donor} is also a survivor`)
      const key = JSON.stringify([v.survivorId, donor])
      const previous = pairs.get(key)
      if (previous) previous.verdicts.push(v.id)
      else pairs.set(key, { survivor: v.survivorId, donor, verdicts: [v.id] })
    }
  }
  return [...pairs.values()]
}

export function classifyReviewedPairs(pairs: readonly ReviewedPair[], has: (id: string) => boolean) {
  const bothPresent: ReviewedPair[] = []
  const donorOnly: ReviewedPair[] = []
  let donorAbsent = 0
  let bothAbsent = 0
  for (const pair of pairs) {
    const keep = has(pair.survivor)
    const donor = has(pair.donor)
    if (keep && donor) bothPresent.push(pair)
    else if (donor) donorOnly.push(pair)
    else if (keep) donorAbsent++
    else bothAbsent++
  }
  return { bothPresent, donorOnly, donorAbsent, bothAbsent }
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.some(a => a !== '--strict')) throw new Error('Usage: npm run audit:reviewed-dupes -- [--strict]')
  const strict = args.includes('--strict')
  const dbPath = process.env.GEOHISTORY_DB ?? 'events.sqlite'
  const pairs = reviewedPairs([...HISTORIC_AUTO_MERGES, ...VERDICTS])
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const query = db.prepare('SELECT 1 FROM events WHERE id = ?')
    const review = classifyReviewedPairs(pairs, id => Boolean(query.get(id)))
    console.log(JSON.stringify({ db: dbPath, strict, manualVerdictGroups: VERDICTS.length, historicAutoGroups: HISTORIC_AUTO_MERGES.length, reviewedPairs: pairs.length, ...review,
      note: 'Exact historic automatic-plan and manual-verdict IDs only. No title matching, automatic deletion, or claim of complete duplicate coverage.' }, null, 2))
    if (strict && (review.bothPresent.length || review.donorOnly.length)) process.exitCode = 1
  } finally { db.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
