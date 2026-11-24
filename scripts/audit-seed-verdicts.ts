/** Report exact historical TSV verdicts against a read-only database; never write data. */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Pair = { survivor: string; donor: string; source: string }
type Row = Record<string, string>

export function parseTsv(text: string, source: string, required: string[]): Row[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.length > 0)
  if (!lines.length) throw new Error(`${source}: empty file`)
  const header = lines[0].split('\t')
  if (new Set(header).size !== header.length || required.some(col => !header.includes(col))) throw new Error(`${source}: invalid header`)
  return lines.slice(1).map((line, i) => {
    const values = line.split('\t')
    if (values.length !== header.length) throw new Error(`${source}:${i + 2}: invalid column count`)
    return Object.fromEntries(header.map((col, n) => [col, values[n].trim()]))
  })
}

export function verdictPairs(source: string, text: string): Pair[] {
  const universal = source === 'dupe-merge-universal.tsv'
  const expected: Record<string, string> = { 'dupe-drop.tsv': 'drop-seed', 'dupe-merge.tsv': 'merge-date-then-drop-seed' }
  if (!universal && !(source in expected)) throw new Error(`Unknown verdict file: ${source}`)
  const required = universal ? ['keep_id', 'donor_id'] : ['verdict', 'dump_id', 'seed_id']
  return parseTsv(text, source, required).map((row, i) => {
    if (!universal && row.verdict !== expected[source]) throw new Error(`${source}:${i + 2}: unexpected verdict`)
    const survivor = universal ? row.keep_id : row.dump_id
    const donor = universal ? row.donor_id : row.seed_id
    if (!survivor || !donor || survivor === donor) throw new Error(`${source}:${i + 2}: invalid pair`)
    return { survivor, donor, source }
  })
}

export function classify(pairs: readonly Pair[], has: (id: string) => boolean) {
  const bothPresent: Pair[] = [], donorOnly: Pair[] = [], neither: Pair[] = []
  let survivorOnly = 0
  for (const pair of pairs) {
    const keep = has(pair.survivor), donor = has(pair.donor)
    if (keep && donor) bothPresent.push(pair)
    else if (donor) donorOnly.push(pair)
    else if (keep) survivorOnly++
    else neither.push(pair)
  }
  return { survivorOnly, bothPresent, donorOnly, neither }
}

function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--strict') || args.length > 1) throw new Error('Usage: npm run audit:seed-verdicts -- [--strict]')
  const strict = args.includes('--strict')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed', 'dupe')
  const names = ['dupe-drop.tsv', 'dupe-merge.tsv', 'dupe-merge-universal.tsv']
  const pairs = names.flatMap(name => verdictPairs(name, readFileSync(join(root, name), 'utf8')))
  const dbPath = process.env.GEOHISTORY_DB ?? 'events.sqlite'
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const query = db.prepare('SELECT 1 FROM events WHERE id = ?')
    const results = Object.fromEntries(names.map(name => {
      const filePairs = pairs.filter(pair => pair.source === name)
      return [name, { pairs: filePairs.length, ...classify(filePairs, id => Boolean(query.get(id))) }]
    }))
    console.log(JSON.stringify({ db: dbPath, strict, results, note: 'Exact TSV verdict pairs only; neither-present cases need review. Keep-both decisions are not deletions. No matching or mutation is performed.' }, null, 2))
    if (strict && Object.values(results).some(r => r.bothPresent.length || r.donorOnly.length || r.neither.length)) process.exitCode = 1
  } finally { db.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
