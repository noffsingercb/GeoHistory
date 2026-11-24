/**
 * Render the standing acceptance fixtures, census them, verify them, or trace a
 * single row through the engine.
 *
 *   npx tsx render-fixture.ts a|b            rendered markdown
 *   npx tsx render-fixture.ts a --json       full timeline JSON
 *   npx tsx render-fixture.ts census         what the fixtures actually render
 *   npx tsx render-fixture.ts verify         baseline checks, non-zero on unexpected failures
 *   npx tsx render-fixture.ts verify --strict also fail for documented open gaps
 *   npx tsx render-fixture.ts trace "Cold War"   why one row looks the way it does
 *
 * timeline.ts is a hardcoded demo (Ada Example, Pueblo -> Chicago) and takes no
 * arguments, so it cannot drive these.
 *
 * Lives at the repo root, not in scripts/, because it imports './core' the way
 * timeline.ts and search.ts do.
 */
import Database from 'better-sqlite3';
import { getTimeline, renderMarkdown, type TimelineInput, type TimelineEntry } from './core.js';
import { checkOccurrences, findDoubledPhaseLines, type Expectation } from './render-fixture-checks.js';

const FIXTURES: Record<string, TimelineInput> = {
	a: {
		person: 'Fixture A',
		segments: [
			{ label: 'Bancroft', place: { name: 'Bancroft, West Virginia, USA', lat: 38.5137, lng: -81.8471 }, start: '1935', end: '1970' },
			{ label: 'Eleanor', place: { name: 'Eleanor, West Virginia, USA', lat: 38.5379, lng: -81.9351 }, start: '1970', end: '2024' },
		],
	},
	b: {
		person: 'Fixture B',
		segments: [
			{ label: 'Thun', place: { name: 'Thun, Switzerland', lat: 46.758, lng: 7.628 }, start: '1725', end: '1749' },
			{ label: 'Philadelphia', place: { name: 'Philadelphia, Pennsylvania, USA', lat: 39.9526, lng: -75.1652 }, start: '1749', end: '1760' },
			{ label: 'York', place: { name: 'York, Pennsylvania, USA', lat: 39.9626, lng: -76.7277 }, start: '1760', end: '1790' },
			{ label: 'Washington', place: { name: 'Washington, Pennsylvania, USA', lat: 40.1734, lng: -80.2462 }, start: '1790' },
		],
	},
};

/** Baseline expectations, identified by row, phase and segment. Dates are ISO
 * display dates, including normalized boundaries for year-precision spans. */
const ACCEPTANCE: Expectation[] = [
  { label: 'Cold War', fixture: 'a', id: 'Q8683', phase: 'begins', segment: 0, want: '1947-03-12' },
  { label: 'Cold War', fixture: 'a', id: 'Q8683', phase: 'ends', segment: 1, want: '1991-12-26' },
  { label: 'Great Depression', fixture: 'a', id: 'Q8698', phase: 'ongoing', segment: 0, want: '1935-01-01' },
  { label: "Seven Years' War", fixture: 'b', id: 'Q33143', phase: 'begins', segment: 1, want: '1756-01-01' },
  { label: "Seven Years' War", fixture: 'b', id: 'Q33143', phase: 'ends', segment: 2, want: '1763-12-31' },
  { label: 'French and Indian War — Catawba people', fixture: 'b', id: 'Q154697#Q55290', phase: 'begins', segment: 1, want: '1754-05-28' },
  { label: 'Industrial Revolution begins', fixture: 'b', id: 'universal:industrial-revolution', phase: 'begins', segment: 1, want: '1760-01-01' },
];

// These are intentionally visible, but not part of the baseline gate until the
// linked selection investigation resolves them. --strict makes them gating.
// https://app.notion.com/p/eab09fb6ac6e4aa1abde0f49b4f96849
const KNOWN_GAPS: Expectation[] = [
  { label: 'French and Indian War — parent', fixture: 'b', id: 'Q154697', phase: 'begins', segment: 1, want: '1754-05-28' },
  { label: 'French and Indian War — parent', fixture: 'b', id: 'Q154697', phase: 'ends', segment: 2, want: '1763-10-07' },
  { label: 'French and Indian War — Catawba people', fixture: 'b', id: 'Q154697#Q55290', phase: 'ends', segment: 2, want: '1763-10-07' },
];

const dbPath = process.env.GEOHISTORY_DB ?? 'events.sqlite';
const db = new Database(dbPath, { readonly: true });

const which = (process.argv[2] ?? '').toLowerCase();
const asJson = process.argv.includes('--json');

function table(label: string, rows: Array<Record<string, string | number>>): void {
	console.log(`\n## ${label}`);
	if (!rows.length) {
		console.log('(none)');
		return;
	}
	const cols = Object.keys(rows[0]);
	console.log(cols.join('\t'));
	for (const r of rows) console.log(cols.map((c) => r[c] ?? '').join('\t'));
}

function tally(values: string[]): Array<{ value: string; n: number; pct: string }> {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts.entries()]
		.sort((x, y) => y[1] - x[1])
		.map(([value, n]) => ({ value, n, pct: `${Math.round((n / values.length) * 1000) / 10}%` }));
}

function allEntries(): Array<TimelineEntry & { fixture: string }> {
	const all: Array<TimelineEntry & { fixture: string }> = [];
	for (const key of ['a', 'b']) {
		for (const e of getTimeline(db, FIXTURES[key]).entries) all.push({ ...e, fixture: key });
	}
	return all;
}

function census(): void {
	const all = allEntries();
	console.log(`RENDERED CENSUS -- ${all.length} entries across fixtures A and B`);

	table('category (rendered, not corpus)', tally(all.map((e) => e.category ?? '(null)')).map((r) => ({ category: r.value, n: r.n, pct: r.pct })));
	table('tier (drives the dot colour)', tally(all.map((e) => e.tier ?? '(null)')).map((r) => ({ tier: r.value, n: r.n, pct: r.pct })));
	table('phase', tally(all.map((e) => e.phase ?? '(point)')).map((r) => ({ phase: r.value, n: r.n, pct: r.pct })));

	table(
		'blast radius of the phase-date fix',
		['a', 'b'].map((f) => {
			const rows = all.filter((e) => e.fixture === f);
			const moved = rows.filter((e) => e.displayDateISO !== e.dateStartISO);
			return {
				fixture: f.toUpperCase(),
				entries: rows.length,
				ranged: rows.filter((e) => e.dateEndISO !== e.dateStartISO).length,
				phased: rows.filter((e) => e.phase).length,
				moved_by_this_fix: moved.length,
			};
		}),
	);

	// A ranged row with NO phase is the interesting population: either its span
	// sits wholly inside one segment (correct, nothing to resolve) or
	// computeRangedOccurrences declined to phase it (a real gap). Named so the
	// difference can be checked rather than assumed.
	table(
		'ranged rows carrying NO phase',
		all
			.filter((e) => e.dateEndISO !== e.dateStartISO && !e.phase)
			.map((e) => ({
				fixture: e.fixture.toUpperCase(),
				start: e.dateStartISO,
				end: e.dateEndISO,
				seg: e.segmentIndex,
				title: (e.displayTitle ?? e.title ?? '').slice(0, 46),
			})),
	);

	table(
		'every row whose displayed date moved',
		all
			.filter((e) => e.displayDateISO !== e.dateStartISO)
			.sort((x, y) => (x.displayDateISO < y.displayDateISO ? -1 : 1))
			.map((e) => ({
				fixture: e.fixture.toUpperCase(),
				phase: e.phase ?? '(point)',
				was: e.dateStartISO,
				now: e.displayDateISO,
				precision: e.displayPrecision,
				title: (e.displayTitle ?? e.title ?? '').slice(0, 46),
			})),
	);
}

/** Baseline failures fail the command; documented open gaps remain visible.
 * --strict also makes those gaps fail, for use while fixing their ticket. */
function verify(): number {
  const timelines = ['a', 'b'].map((fixture) => ({ fixture, timeline: getTimeline(db, FIXTURES[fixture]) }));
  const entries = timelines.flatMap(({ fixture, timeline }) => timeline.entries.map((e) => ({ ...e, fixture })));
  const toRows = (results: ReturnType<typeof checkOccurrences>): Array<Record<string, string | number>> => results.map((r) => ({
    row: r.label, fixture: r.fixture.toUpperCase(), id: r.id, phase: r.phase ?? '(point)',
    seg: r.segment, want: r.want, shows: r.shows, verdict: r.verdict,
  }));
  const baseline = checkOccurrences(ACCEPTANCE, entries);
  const gaps = checkOccurrences(KNOWN_GAPS, entries);
  const doubled = timelines.flatMap(({ fixture, timeline }) => findDoubledPhaseLines(renderMarkdown(timeline))
    .map((line) => ({ fixture: fixture.toUpperCase(), line })));
  const failures = baseline.filter((r) => r.verdict !== 'PASS').length + doubled.length;
  const unresolved = gaps.filter((r) => r.verdict !== 'PASS').length;

  console.log(`Dataset version: ${timelines[0].timeline.datasetVersion ?? 'unknown'}; database: ${dbPath}`);
  table('BASELINE ACCEPTANCE', toRows(baseline));
  table('DOUBLED VERB in rendered output (must be empty)', doubled);
  table('KNOWN GAPS — participant selection ticket; gating only with --strict', toRows(gaps));
  if (failures) console.log(`\nBASELINE FAILED — ${failures} problem(s)`);
  else console.log('\nBASELINE PASSED');
  if (unresolved) console.log(`${unresolved} known gap(s) remain; --strict treats these as failures.`);
  return failures || (process.argv.includes('--strict') && unresolved) ? 1 : 0;
}

/**
 * Why does one row look the way it does? Prints every occurrence of a matching
 * title in both fixtures with the fields that decide its date, plus the raw
 * events.sqlite row behind it, so a disagreement between the two is visible.
 */
function trace(term: string): void {
	console.log(`TRACE: ${term}`);

	for (const key of ['a', 'b']) {
		const timeline = getTimeline(db, FIXTURES[key]);
		const hits = timeline.entries.filter((e) =>
			((e.displayTitle ?? '') + ' ' + (e.title ?? '')).toLowerCase().includes(term.toLowerCase()),
		);
		table(
			`fixture ${key.toUpperCase()} -- rendered occurrences`,
			hits.map((e) => ({
				id: e.id,
				seg: e.segmentIndex,
				phase: e.phase ?? '(point)',
				start: e.dateStartISO,
				end: e.dateEndISO,
				shows: e.displayDateISO ?? '(unset)',
				prec: e.displayPrecision ?? '-',
				tier: e.tier ?? '-',
				score: e.score,
				title: (e.displayTitle ?? e.title ?? '').slice(0, 40),
			})),
		);
	}

	// The corpus row underneath. If the engine shows one occurrence where two
	// were expected, the answer is usually here -- a missing date_end, or a
	// significance under the segment's floor.
	table(
		'events.sqlite rows matching',
		db
			.prepare(
				`SELECT id, category, scope, date_start, date_end, date_precision,
				        significance, reach_km, substr(COALESCE(display_title, title),1,44) AS title
				 FROM events WHERE title LIKE ? OR COALESCE(display_title,'') LIKE ?
				 ORDER BY significance DESC LIMIT 15`,
			)
			.all(`%${term}%`, `%${term}%`) as Array<Record<string, string | number>>,
	);
}

let exitCode = 0;
try {
	if (which === 'census') {
		census();
	} else if (which === 'verify') {
		exitCode = verify();
	} else if (which === 'trace') {
		const term = process.argv[3];
		if (!term) {
			console.error('Usage: npx tsx render-fixture.ts trace "Cold War"');
			exitCode = 1;
		} else {
			trace(term);
		}
	} else if (!FIXTURES[which]) {
		console.error(`Usage: npx tsx render-fixture.ts <a|b|census|verify|trace> [--json]\n\nUnknown mode: ${process.argv[2] ?? '(none)'}`);
		exitCode = 1;
	} else {
		const timeline = getTimeline(db, FIXTURES[which]);
		if (asJson) {
			console.log(JSON.stringify(timeline, null, 2));
		} else {
			console.log(renderMarkdown(timeline));
			console.log(`\n--- ${timeline.entries.length} entries, dataset ${timeline.datasetVersion}, ${timeline.generatedWith} ---`);
		}
	}
} finally {
	db.close();
}
process.exit(exitCode);
