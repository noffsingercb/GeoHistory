// ===================== Shared blurb classifiers =====================
// Older ingest versions picked a category from an item's P31 types and then
// discarded them. Schema v0.6 retains the first 12 P31 QIDs in wikidata_types,
// while events.blurb remains the fallback signal for older rows.
//
// This module exists so classifiers are shared instead of drifting apart. It is
// pure -- no DB, no side effects -- so any script can import it.

/**
 * Wikidata descriptions are noun phrases that lead with the subject's class:
 * "university in Toronto, Ontario, Canada", "for-profit college based in the
 * United States". Everything after the first comma is almost always location or
 * qualification, so restricting the match to the head phrase is what separates
 * "school in Cook County" (an institution) from "school shooting in Cook County"
 * (an event that merely mentions one).
 */
function headPhrase(blurb: string): string {
  return blurb.toLowerCase().split(',')[0].trim().slice(0, 80);
}

/**
 * Incident vocabulary vetoes the institution test outright. A disaster AT an
 * institution is history and must keep its full reach -- capping the Bath School
 * disaster or a hospital fire to a 300 km radius would be a worse error than the
 * one this module fixes.
 */
const INCIDENT: RegExp[] = [
  /\b(disaster|catastrophe|tragedy)\b/,
  /\b(shooting|massacre|murder|killing|assassination)\b/,
  /\b(fire|explosion|blast|bombing|arson)\b/,
  /\b(attack|siege|raid|invasion|battle|war|uprising|revolt|riot)\b/,
  /\b(collapse|crash|wreck|sinking|derailment)\b/,
  /\b(epidemic|pandemic|outbreak|famine)\b/,
  /\b(strike|walkout|lockout|protest|demonstration|boycott)\b/,
  /\b(scandal|controversy|trial|lawsuit|bankruptcy|closure|dissolution)\b/,
  /\b(flood|earthquake|hurricane|tornado|cyclone|eruption|avalanche|landslide)\b/,
];

/**
 * Institution nouns, deliberately CONSERVATIVE.
 *
 * Omitted on purpose: "organization", "intergovernmental organization",
 * "association", "society", "institute", "foundation", "political party",
 * "trade union". Those cover the United Nations, the Red Cross, NATO, the Royal
 * Society and every party founding in the corpus -- rows whose founding genuinely
 * was national or global news. A false demotion there costs more than leaving a
 * few minor bodies at their ladder scope, so they are left alone.
 */
const INSTITUTION: RegExp[] = [
  // education
  /\b(university|college|polytechnic|academy|seminary|conservatory|gymnasium)\b/,
  /\b(school|schools)\b/,
  // health
  /\b(hospital|infirmary|clinic|sanatorium|asylum|medical cent(er|re))\b/,
  // culture and knowledge
  /\b(museum|art gallery|library|archive|observatory|planetarium|botanical garden|arboretum|zoo|aquarium)\b/,
  /\b(theatre|theater|opera house|concert hall|cinema|stadium|arena|racecourse)\b/,
  // commerce
  /\b(company|corporation|firm|manufacturer|conglomerate|retailer|chain|brand)\b/,
  /\b(bank|insurer|brewery|distillery|winery|foundry|mill|factory|shipyard|refinery)\b/,
  /\b(airline|railway company|shipping line|bus company|publisher|publishing house|record label|film studio)\b/,
  // media
  /\b(newspaper|magazine|periodical|tabloid|broadcaster)\b/,
  /\b(television (channel|station|network)|radio (channel|station|network))\b/,
  // sport
  /\b((association )?football club|sports club|sports team|baseball team|basketball team|ice hockey team|cricket club|rugby club)\b/,
  // religion
  /\b(church|cathedral|basilica|chapel|abbey|monastery|convent|priory|mosque|synagogue|temple|parish|diocese)\b/,
  // hospitality and retail premises
  /\b(hotel|inn|restaurant|casino|department store|shopping (mall|centre|center))\b/,
];

/**
 * True when the blurb describes a standing institution rather than something that
 * happened. Used to cap scope: an institution's founding is local or regional news
 * however famous the institution later became.
 */
export function isInstitution(blurb: string | null | undefined): boolean {
  if (!blurb) return false;
  const b = blurb.toLowerCase();
  if (INCIDENT.some((re) => re.test(b))) return false;
  const head = headPhrase(blurb);
  return INSTITUTION.some((re) => re.test(head));
}

// Creative-work P31 classes used by the media pruner:
// Q11424 film; Q5398426 television series; Q581714 animated series;
// Q63952888 animated television series; Q117467246 animated television series /
// animated TV-work subtype observed in dump-v0.6; Q7889 video game; Q196600 media
// franchise; Q178296 comic strip; Q21191134 comic-strip type observed on Garfield
// in dump-v0.6; Q838795 comic-strip type observed on Peanuts in dump-v0.6;
// Q213369 webcomic; Q8261 novel; Q482994 album; Q7366 song; Q24634210 podcast.
const MEDIA_TYPES = new Set([
  'Q11424',
  'Q5398426',
  'Q581714',
  'Q63952888',
  'Q117467246',
  'Q7889',
  'Q196600',
  'Q178296',
  'Q21191134',
  'Q838795',
  'Q213369',
  'Q8261',
  'Q482994',
  'Q7366',
  'Q24634210',
]);

const MEDIA_CREATOR = /\b(actor|director|screenwriter)\b/;
const MEDIA_HEAD: RegExp[] = [
  /\bfilm(?: series)?(?:\s*\([^)]*\))?$/,
  /\b(?:television|tv) (?:series|sitcom|miniseries|program|programme|show)(?:\s*\([^)]*\))?$/,
  /\banimated (?:television )?series(?:\s*\([^)]*\))?$/,
  /\bvideo game(?: series)?(?:\s*\([^)]*\))?$/,
  /\b(?:media|multimedia) franchise\b/,
  /\bfranchise(?:\s*\([^)]*\))?$/,
  /\b(?:comic strip|webcomic)(?:\s*\([^)]*\))?$/,
  /\bnovel(?: series)?(?:\s*\([^)]*\))?$/,
  /\balbum(?:\s*\([^)]*\))?$/,
  /\bsong(?:\s*\([^)]*\))?$/,
  /\bpodcast(?: series)?(?:\s*\([^)]*\))?$/,
];

export type WikidataTypes = string | readonly string[] | null | undefined;

/** Returns normalized P31 values when supplied, otherwise null. */
function normalizeWikidataTypes(wikidataTypes: WikidataTypes): string[] | null {
  if (Array.isArray(wikidataTypes)) {
    const values = wikidataTypes.filter((value): value is string => typeof value === 'string' && value.length > 0);
    return values.length > 0 ? values : null;
  }
  if (typeof wikidataTypes !== 'string') return null;
  const raw = wikidataTypes.trim();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const values = parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
      return values.length > 0 ? values : null;
    }
  } catch {
    // A direct QID is still useful type evidence. Other malformed values fall
    // through to the conservative head-phrase fallback below.
  }
  return [raw];
}

/**
 * True when P31 identifies a creative work, or when the description's head phrase
 * strongly identifies one. Unknown P31 types do not suppress the head-phrase
 * fallback: dump-v0.6 contains media-specific P31 subclasses not in this list.
 * The fallback rejects creator-person phrases so "American film director" cannot
 * classify the person as the film.
 */
export function isMedia(blurb: string | null | undefined, wikidataTypes: WikidataTypes): boolean {
  const types = normalizeWikidataTypes(wikidataTypes);
  if (types?.some((qid) => MEDIA_TYPES.has(qid))) return true;
  if (!blurb) return false;
  const head = headPhrase(blurb);
  if (MEDIA_CREATOR.test(head)) return false;
  return MEDIA_HEAD.some((re) => re.test(head));
}
