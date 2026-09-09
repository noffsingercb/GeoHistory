import type { Phase, Precision } from './core.js';

// ===================== Phase-aware display dates =====================
//
// Bookending (0.6, item B.7) decides WHERE a ranged row is drawn: the segment
// holding date_start ('begins'), the one holding date_end ('ends'), or the
// earliest overlapping segment when the span was already running ('ongoing').
// It never decided WHAT DATE that occurrence renders at, so every occurrence
// inherited date_start and the 'ends' card landed decades early:
//
//   Cold War -- ends, 12 Mar 1947          (should be 1991)
//   Seven Years' War -- ends, 1756         (should be 1763)
//   Great Depression -- ongoing, 24 Oct 1929, printed ABOVE the 1935 BORN card
//
// The resolved date below is what the entry renders and sorts at. date_start
// and date_end are still reported unchanged on the entry, so nothing that
// reasons about the underlying span loses information.

/**
 * Coarseness ranking. Lower is coarser. Used to pick the honest precision when
 * two are in play -- see displayDateFor's 'ends' branch.
 */
const PRECISION_RANK: Record<Precision, number> = {
  century: 0,
  decade: 1,
  year: 2,
  month: 3,
  day: 4,
};

/** The coarser of two precisions. Never claims more exactness than both agree on. */
export function coarserPrecision(a: Precision, b: Precision): Precision {
  return PRECISION_RANK[a] <= PRECISION_RANK[b] ? a : b;
}

export interface DisplayDate {
  /** The ISO day this occurrence renders and sorts at. */
  iso: string;
  /** How much of that ISO day is real. See the 'ongoing' note below. */
  precision: Precision;
}

/**
 * Resolve the date a single occurrence of a row should render and sort at.
 *
 * @param phase         the occurrence's phase, from computeRangedOccurrences
 * @param dateStartISO  the row's span start (inclusive)
 * @param dateEndISO    the row's span end (inclusive)
 * @param startPrecision  precision of the stored date_start
 * @param endPrecision    precision implied by the stored date_end STRING --
 *   a row storing date_end '1991' is year-precise at its end even when
 *   date_precision says 'day', which is true of most ranged Wikidata rows
 * @param segmentStartISO the life segment's first day, used to anchor 'ongoing'
 */
export function displayDateFor(
  phase: Phase,
  dateStartISO: string,
  dateEndISO: string,
  startPrecision: Precision,
  endPrecision: Precision,
  segmentStartISO: string,
): DisplayDate {
  if (phase === 'ends') {
    // date_end is normalized to the LAST day of whatever granularity was
    // stored, so a row ending '1991' arrives here as 1991-12-31. Rendering
    // that as 'December 31, 1991' would invent a day the source never
    // claimed, hence the coarser-of-the-two precision.
    return { iso: dateEndISO, precision: coarserPrecision(startPrecision, endPrecision) };
  }

  if (phase === 'ongoing') {
    // The span was already running when this life began, so there is no
    // meaningful day to print -- the card means "this was going on", and it
    // must anchor at the segment start or it sorts above the BORN card.
    // Always year precision: the segment's own start day is the person's,
    // not the event's, and printing it would attribute one to the other.
    return { iso: segmentStartISO, precision: 'year' };
  }

  // 'begins' and point-in-time rows (phase null) are already correct.
  return { iso: dateStartISO, precision: startPrecision };
}

// ===================== Phase suffix =====================
//
// The cosmetic half of the same ticket. A handful of authored rows in
// seed/universal-v0.1.json carry the verb in the title already -- "Industrial
// Revolution begins", "The Reformation begins" -- so appending the phase
// produced "Industrial Revolution begins -- begins".
//
// Suppressing the suffix is preferred over stripping the verb from
// display_title: the authored titles are correct as written, a strip would
// have to run on every ingest and stay in sync with the seed file, and a row
// titled "Industrial Revolution begins" drawn as 'ends' should say neither
// "-- ends" (contradiction) nor lose the title's own verb.

/**
 * True when a display title already states its own phase, so a suffix would
 * double the verb. Anchored to the end of the string: "The War That Ended
 * Wars" is not a match, "Industrial Revolution begins" is.
 */
const TITLE_STATES_PHASE = /\b(begins?|began|beginning|starts?|started|ends?|ended|ending|opens?|opened|closes?|closed)\s*$/i;

export function titleStatesPhase(displayTitle: string): boolean {
  return TITLE_STATES_PHASE.test(displayTitle.trim());
}

/**
 * The suffix to append to a display title for a given phase, or '' when none
 * applies -- either because the row is a point event or because the title
 * already carries the verb.
 *
 * @param separator the string placed between title and phase word. The engine's
 *   Markdown renderer and Circa's EntryCard use different typography, so the
 *   RULE lives here once and only the punctuation is passed in.
 */
export function phaseSuffixFor(displayTitle: string, phase: Phase, separator = ' \u2014 '): string {
  if (!phase) return '';
  if (titleStatesPhase(displayTitle)) return '';
  return `${separator}${phase}`;
}
