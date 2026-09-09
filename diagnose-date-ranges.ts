import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';

// ===================== Why this exists =====================
//
// P580 (start time) is ingested verbatim and trusted. For a long-running event
// that is often wrong in a way no scoring pass can catch, because the claim
// itself is well-formed -- it just refers to a precursor rather than the event:
//
//   American Revolution           date_start 1763-03-22  blurb "1765-1783"
//   War of the Polish Succession  date_start 1733-10-10  blurb "1734-1738"
//   Seven Years' War              date_start 1754-05-28  blurb "1756-1763"
//
// The blurb is the check: it is prose lifted from the source and routinely
// states the span the reader expects. When date_start falls outside the year
// range the blurb states, one of the two is wrong and a human should look.
//
// This is a DIAGNOSTIC, not a fix. It never edits events. --apply writes a
// candidate override list to seed/date-overrides.json for review, exactly the
// way seed/scope-pins.json carries hand-checked scope decisions. Nothing
// consumes that file yet -- wiring it into the ingest is a separate change,
// deliberately, so the flagged set can be read before anything acts on it.

const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';
const OVERRIDE_PATH = 'seed/date-overrides.json';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : Infinity;
})();

// ===================== Blurb range extraction =====================
//
// Only ever matches an EXPLICIT year range. A single year in prose is not
// evidence of a span ("...the worst since 1893"), so it is ignored outright --
// this pass is built to under-report rather than to guess.
//
// Accepts 1756-1763, 1756\u20131763 (en dash), 1756 to 1763, and the abbreviated
// 1914-18 form. Rejects a range whose end precedes its start, and rejects
// spans longer than 200 years, which in practice are century labels rather
// than event spans.
const RANGE_PATTERNS: RegExp[] = [
  /\b(1[0-9]{3}|20[0-9]{2})\s*(?:-|\u2013|\u2014|\bto\b)\s*(1[0-9]{3}|20[0-9]{2})\b/,
  /\b(1[0-9]{3}|20[0-9]{2})\s*(?:-|\u2013|\u2014)\s*([0-9]{2})\b/,
];

interface BlurbRange { lo: number; hi: number; matched: string; }

export function blurbRange(blurb: string | null): BlurbRange | null {
  if (!blurb) return null;
  for (const re of RANGE_PATTERNS) {
    const m = blurb.match(re);
    if (!m) continue;
    const lo = parseInt(m[1], 10);
    let hi = parseInt(m[2], 10);
    // Abbreviated form: 1914-18 means 1918, not year 18.
    if (m[2].length === 2) hi = Math.floor(lo / 100) * 100 + hi;
    if (hi < lo) continue;
    if (hi - lo > 200) continue;
    return { lo, hi, matched: m[0] };
  }
  return null;
}

const yearOf = (iso: string | null): number | null => {
  if (!iso) return null;
  const m = iso.match(/^(\d{3,4})/);
  return m ? parseInt(m[1], 10) : null;
};

// ===================== Report =====================

type Finding = {
  id: string;
  title: string;
  displayTitle: string | null;
  scope: string | null;
  significance: number | null;
  dateStart: string | null;
  dateEnd: string | null;
  blurbLo: number;
  blurbHi: number;
  blurbMatch: string;
  /** Why this row was flagged. Drives which section it prints under. */
  kind: 'start-before-range' | 'start-after-range' | 'missing-end';
  /** What the blurb implies the values should be. Suggestion only. */
  suggestedStart: string;
  suggestedEnd: string;
};

function main() {
  const db = new Database(DB_PATH, { readonly: !APPLY });
  db.pragma('journal_mode = WAL');

  const columns = new Set(
    (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  const hasDisplayTitle = columns.has('display_title');

  // Only rows that could plausibly be long-running. A row with no blurb has
  // nothing to check against, and single-day rows are out of scope here --
  // this ticket is about spans.
  const rows = db.prepare(`
    SELECT id, title, ${hasDisplayTitle ? 'display_title' : 'NULL AS display_title'},
           blurb, date_start, date_end, scope, significance
    FROM events
    WHERE blurb IS NOT NULL AND date_start IS NOT NULL
    ORDER BY significance DESC, id ASC
  `).all() as Array<{
    id: string; title: string; display_title: string | null; blurb: string | null;
    date_start: string | null; date_end: string | null; scope: string | null;
    significance: number | null;
  }>;

  const findings: Finding[] = [];

  for (const row of rows) {
    const range = blurbRange(row.blurb);
    if (!range) continue;
    const startYear = yearOf(row.date_start);
    if (startYear === null) continue;

    const endYear = yearOf(row.date_end);
    const base = {
      id: row.id,
      title: row.title,
      displayTitle: row.display_title,
      scope: row.scope,
      significance: row.significance,
      dateStart: row.date_start,
      dateEnd: row.date_end,
      blurbLo: range.lo,
      blurbHi: range.hi,
      blurbMatch: range.matched,
      suggestedStart: String(range.lo),
      suggestedEnd: String(range.hi),
    };

    if (startYear < range.lo) {
      // The precursor case -- American Revolution at 1763 against "1765-1783".
      findings.push({ ...base, kind: 'start-before-range' });
    } else if (startYear > range.hi) {
      findings.push({ ...base, kind: 'start-after-range' });
    } else if (endYear === null && range.hi > range.lo) {
      // date_start agrees with the blurb, but P582 was missing at ingest, so
      // the engine treats a real span as a point event -- which means it can
      // never draw an 'ends' card no matter what the display-date fix does.
      findings.push({ ...base, kind: 'missing-end' });
    }
  }

  const byKind = (k: Finding['kind']) => findings.filter((f) => f.kind === k);

  const section = (label: string, list: Finding[]) => {
    console.log(`\n${label}  (${list.length})`);
    console.log('-'.repeat(label.length + 8));
    for (const f of list.slice(0, LIMIT)) {
      const name = f.displayTitle?.trim() || f.title;
      console.log(
        `  ${f.id}  ${name}\n` +
        `      stored  ${f.dateStart} \u2192 ${f.dateEnd ?? '(none)'}\n` +
        `      blurb   "${f.blurbMatch}"  implies ${f.blurbLo} \u2192 ${f.blurbHi}\n` +
        `      scope ${f.scope ?? '?'}  sig ${f.significance ?? '?'}`,
      );
    }
    if (list.length > LIMIT) console.log(`  ... ${list.length - LIMIT} more (raise --limit=)`);
  };

  console.log(`diagnose-date-ranges  db=${DB_PATH}  rows scanned=${rows.length}`);
  section('date_start precedes the range the blurb states', byKind('start-before-range'));
  section('date_start follows the range the blurb states', byKind('start-after-range'));
  section('blurb states a span but date_end is missing', byKind('missing-end'));

  console.log(`\ntotal flagged: ${findings.length} of ${rows.length} scanned`);

  if (!APPLY) {
    console.log('\nread-only. re-run with --apply to write ' + OVERRIDE_PATH);
    db.close();
    return;
  }

  // Written for a human to edit down, not to be consumed as-is. Every entry
  // starts unapproved; nothing should act on this file until someone has read
  // the rows and set approved.
  const payload = {
    generated: new Date().toISOString(),
    db: DB_PATH,
    note: 'Candidate date corrections inferred from blurb prose. Review and set approved:true before anything consumes this.',
    overrides: findings.map((f) => ({
      id: f.id,
      title: f.displayTitle?.trim() || f.title,
      kind: f.kind,
      approved: false,
      stored: { date_start: f.dateStart, date_end: f.dateEnd },
      suggested: { date_start: f.suggestedStart, date_end: f.suggestedEnd },
      evidence: f.blurbMatch,
    })),
  };

  mkdirSync('seed', { recursive: true });
  writeFileSync(OVERRIDE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`\nwrote ${OVERRIDE_PATH} (${payload.overrides.length} candidates, all approved:false)`);

  try {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_date_range_diag', @v)
                ON CONFLICT(key) DO UPDATE SET value = @v`)
      .run({ v: new Date().toISOString() });
  } catch { /* meta table may not exist on older DBs */ }

  db.close();
}

main();
