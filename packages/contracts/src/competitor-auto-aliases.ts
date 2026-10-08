import { z } from 'zod'
import { answerProseForMentions, isCitationLabel, stripCitationChips } from './answer-prose.js'
import { MIN_BRAND_ALIAS_KEY_LENGTH, MIN_DOMAIN_BRAND_KEY_LENGTH } from './answer-visibility.js'
import {
  aliasOccurrencesAsWritten,
  brandKeyFromText,
  brandWords,
  compileBrandAliases,
  matchedAliasKeys,
} from './brand-matching.js'
import {
  cleanBusinessNameCandidate,
  extractBusinessNameCandidates,
  MAX_BUSINESS_NAME_WORDS,
} from './business-name-candidates.js'
import {
  competitorNameAliases,
  planCompetitorAutoAliases,
  type CompetitorAliasMarketPin,
  type CompetitorAliasProjectIdentity,
} from './competitor-aliases.js'
import { fraction, roundRatio, RatioUnits } from './ratio-unit.js'
import {
  brandLabelFromDomain,
  extractDomainsFromText,
  hostOf,
  normalizeCompetitorDomain,
  registrableDomain,
} from './url-normalize.js'

/**
 * COMPETITOR NAMES LEARNED FROM THE ANSWERS.
 *
 * A competitor is tracked as a domain, but answers name it by brand, and the
 * brand is often not the domain label (a shop at `spoketuneworks.example` is
 * "TuneSpoke" in prose). Curated aliases close that gap by hand; this module
 * closes it from evidence the project already stored. Nothing here reads a
 * competitor's website or calls a network: every input is a stored answer.
 *
 * EVIDENCE. An answer PAIRS a name with a site when its own citation structure
 * ties the two together:
 * - a provider citation anchors a stretch of answer prose to a source URL
 *   (OpenAI `url_citation` annotations, Claude `web_search_result_location`
 *   citations, Gemini grounding supports, Perplexity `[N]` markers); the
 *   provider packages read those (`extractAnchoredSpans`), and the names come
 *   from that stretch by layout (`extractBusinessNameCandidates`);
 * - the answer text itself writes the pair: a named link
 *   `[TuneSpoke](https://spoketuneworks.example/...)`, `TuneSpoke
 *   (spoketuneworks.example)` or `TuneSpoke - spoketuneworks.example`
 *   (`extractAnswerTextAnchors`).
 * A CO-OCCURRENCE is weaker: the answer cites the competitor and lays the name
 * out as a business somewhere else in it. It is counted and reported, never
 * enough on its own: on stored answers, names backed only by co-occurrence
 * were other businesses in the same list, section headings and how-to steps.
 *
 * WHAT REJECTS A PHRASE THAT IS NOT A BRAND. Three measures over the scanned
 * answers whose prose names the candidate as complete words (the mention
 * matcher's text, `answerProseForMentions`), outside any longer name of the
 * same competitor (its domain label, a curated alias, a longer stored name,
 * and for a competitor only an Advanced market pins its plan label and
 * aliases): when the brand is "Lark Bay Suites", an answer that writes only
 * "Lark Bay Suites" says nothing about the shorter candidate "Lark Bay"
 * (often the place), and counting it would hand that truncation the brand's
 * own precision and lift:
 * - PRECISION: the share of them that cite the competitor's domain. A floor
 *   only: in a category where answers list many businesses and cite few
 *   (hotels), real brands sat between 0.06 and 0.4 on stored answers, while
 *   a street name and a section heading tied to a hotel's domain sat at 0.34
 *   and 0.40, so precision does not separate the two.
 * - LIFT: precision over the competitor's citation rate in the answers that
 *   do NOT name it (Laplace-smoothed, so a name every answer carries has no
 *   contrast and fails). This is what rejects a generic phrase: a competitor
 *   cited in half of all answers gives almost any phrase a precision near 0.5,
 *   but naming that phrase barely changes the citation rate. On stored
 *   answers that street name and heading had lift 1.2 and 1.5; the lowest
 *   real brand its domain label did not already match had 7.3.
 * - NAME CASING: the share of them that write it capitalized as a name. A
 *   brand stays capitalized in prose ("Spoke Garage"); a service phrase
 *   comes back lowercase ("roof repair after hail").
 *
 * RULES to apply a name automatically (`AUTO_ALIAS_*` constants, tuned on
 * about 4.8k stored answers across 6 projects and 96 tracked competitors):
 * direct pairs in at least `AUTO_ALIAS_MIN_DIRECT_ANSWERS` answers from at
 * least `AUTO_ALIAS_MIN_RUNS` distinct sweeps (runs started together, one
 * multi-location sweep, count once); at least `AUTO_ALIAS_MIN_NAMING_ANSWERS`
 * answers naming it; precision at least `AUTO_ALIAS_MIN_PRECISION`; lift at
 * least `AUTO_ALIAS_MIN_LIFT`; name casing at least
 * `AUTO_ALIAS_MIN_NAME_CASED_SHARE`; a name shape (`isAutoAliasNameShaped`,
 * which also rejects place shapes such as "Larkfield, CO" and "Metro
 * Larkfield"); this competitor holds at least `AUTO_ALIAS_DOMINANCE_RATIO`
 * times the direct pairs of any other tracked competitor for the name (a
 * business described next to several citations belongs to its own site); a
 * brand key of at least `AUTO_ALIAS_MIN_KEY_LENGTH` (a 3-letter name is
 * listed for review, `needs-approval`, as a 3-letter domain label needs
 * approval); and LABEL AFFINITY with the domain (`hasDomainLabelAffinity`).
 * Applied names then pass the shared identity rules
 * (`planCompetitorAutoAliases`), strongest evidence first into the
 * `COMPETITOR_ALIAS_LIMIT` cap.
 *
 * Why affinity stays required: a competitor's site describes OTHER things it
 * is cited next to (a partner it integrates with, a rival it compares itself
 * to, its neighborhood, a service it sells), and those pair with the site,
 * rise with it, and are written as names, so pairing, lift and casing cannot
 * tell them from its brand. On stored answers, of the 7 names without
 * affinity that passed every other rule even at a stricter bar (4 pairs over
 * 3 sweeps, precision 0.5, lift 10), 1 was the competitor's own name; the
 * rest were other companies it integrates with or is listed beside, a
 * product feature and a generic phrase. One word the name shares with the
 * label is not affinity either, unless the word is the whole label: a city
 * the label opens or ends with, or a neighbouring business sharing the word
 * the label opens with, passed every scoring rule on stored answers, and so
 * does a neighbour that adds a word found further on in the label. Those
 * names are listed for review (`no-label-affinity`)
 * for an operator to verify and add as curated aliases, after the identity
 * rules that need no other auto name (`planCompetitorAutoAliases` review),
 * at the 3-character curated floor: never a name overlapping the project's
 * names or hosts, another competitor's domain label, host or curated alias,
 * or a market pin of another domain, a blocked name, or one the
 * competitor's own names or planned auto names already match. Unlike
 * applied names, review names are not checked against other competitors'
 * auto-detected names, so a name another competitor stores or learns in the
 * same pass can still be listed.
 */

/** Distinct answers that must pair the name with the competitor's site. */
export const AUTO_ALIAS_MIN_DIRECT_ANSWERS = 2
/**
 * Distinct sweeps those pairing answers must come from. Runs created at the
 * same moment (one `--all-locations` sweep fanned out per location) are one
 * sweep: two locations of one sweep are not two independent observations.
 */
export const AUTO_ALIAS_MIN_RUNS = 2
/** Scanned answers that must name the candidate, so precision has a denominator. */
export const AUTO_ALIAS_MIN_NAMING_ANSWERS = 3
/**
 * Lowest precision (answers citing the competitor / answers naming the
 * candidate) an applied name may have. A floor under lift, not the generic
 * phrase filter: see the module header.
 */
export const AUTO_ALIAS_MIN_PRECISION = 0.1
/**
 * Lowest lift an applied name may have: precision over the competitor's
 * smoothed citation rate in answers that do not name it. Between the
 * non-brands with label affinity (1.2, 1.5) and the lowest real brand (7.3)
 * on stored answers.
 */
export const AUTO_ALIAS_MIN_LIFT = 3
/**
 * Lowest share of naming answers that write the name capitalized as a name.
 * On stored answers real names sat at 0.83 and above (a product name written
 * in lowercase once in 6); common-word phrases paired with a site ("Service
 * Area", "Long Lifespan") sat at 0.08 to 0.70. Place names stay capitalized,
 * which is why lift and label affinity still apply.
 */
export const AUTO_ALIAS_MIN_NAME_CASED_SHARE = 0.75
/**
 * A stored name is removed only when the scanned answers contradict it
 * clearly, below these LOWER bounds (at least `AUTO_ALIAS_MIN_NAMING_ANSWERS`
 * answers naming it): a name near the apply thresholds would otherwise flip
 * on and off from one pass to the next, and every flip rewrites stored
 * competitor fields. Casing is checked too: a name answers start writing in
 * lowercase ("rim doctor" for a "Rim Doctor" brand) has become an ordinary phrase.
 */
export const AUTO_ALIAS_REMOVE_BELOW_PRECISION = 0.05
export const AUTO_ALIAS_REMOVE_BELOW_LIFT = 1.5
export const AUTO_ALIAS_REMOVE_BELOW_NAME_CASED_SHARE = 0.5
/** Shortest brand key detection applies on its own: the domain-label floor. */
export const AUTO_ALIAS_MIN_KEY_LENGTH = MIN_DOMAIN_BRAND_KEY_LENGTH
/** This competitor's direct pairs must be at least this multiple of any other tracked competitor's. */
export const AUTO_ALIAS_DOMINANCE_RATIO = 2
/** Most review suggestions and most rejected candidates listed per competitor. */
export const AUTO_ALIAS_REPORT_LIMIT = 10
/** Most recent answer-visibility runs a detection pass scans. */
export const AUTO_ALIAS_SCAN_MAX_RUNS = 60
/** A pass stops reading snapshots once it has read this many, mid-run if need be. */
export const AUTO_ALIAS_SCAN_MAX_SNAPSHOTS = 6000

/** How an answer tied a stretch of its prose to a source. */
export const anchoredSpanSourceSchema = z.enum([
  'openai-annotation',
  'claude-citation',
  'gemini-support',
  'perplexity-marker',
  'answer-link',
  'answer-host',
])
export type AnchoredSpanSource = z.infer<typeof anchoredSpanSourceSchema>
export const AnchoredSpanSources = anchoredSpanSourceSchema.enum

/**
 * A stretch of one answer's prose that the answer ties to a source.
 * `kind: 'window'` holds layout (a list item, a sentence) the names are read
 * from; `kind: 'name'` is the name itself (a named link's label).
 */
export interface AnchoredAnswerSpan {
  text: string
  /** The source as a URL or a bare host. */
  source: string
  kind: 'window' | 'name'
  via: AnchoredSpanSource
}

const NAME_CONNECTOR_WORDS: ReadonlySet<string> = new Set(['of', 'the', 'and', '&', 'de', 'la', 'n', 'y', 'at', 'on', 'by', 'for', 'in'])
/** First words that open headings and how-to lines, never a business name. */
const NON_NAME_LEAD_WORDS: ReadonlySet<string> = new Set(['why', 'how', 'what', 'when', 'where', 'who', 'which', 'to', 'key', 'top', 'best', 'our', 'your'])
/** Characters of stats, questions, labels and paths, never of a business name. */
const NON_NAME_CHARACTERS = /[%+?:/|]/
/**
 * A written host or URL (`spoketuneworks.example`, `www.qvx.example/parts`),
 * recognized by shape rather than by a TLD list, so a source address is never
 * read as a business name whatever its suffix.
 */
const HOST_SHAPED = /^(?:https?:\/\/)?(?:www\.)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,63}(?:[/?#]\S*)?$/iu

/** Legal suffixes dropped before the subsequence affinity check. */
const LEGAL_SUFFIX_KEYS: readonly string[] = ['company', 'corp', 'inc', 'llc', 'ltd', 'co']

/**
 * Words a registrant puts before a brand in a domain label
 * (`thehotelwren.example`, `myspokeiq.example`): a name may open the label
 * right after one.
 */
const LABEL_LEAD_WORDS: readonly string[] = ['the', 'get', 'try', 'go', 'my', 'use', 'hey', 'join', 'shop', 'visit']

/**
 * Codes written after a comma in a place ("Larkfield, CO"): US states and
 * territories, Canadian provinces, Australian states, and country codes.
 * Matched as written, so "Acme, Co" (a company) stays a name.
 * `CREDENTIAL_PLACE_CODES` are also written after a firm's or a person's name.
 */
const PLACE_CODES: ReadonlySet<string> = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR', 'GU', 'VI',
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
  'NSW', 'VIC', 'QLD', 'TAS', 'ACT',
  'US', 'USA', 'UK',
])
/** US state names, lowercased, written after a comma in a place ("Larkfield, Colorado"). */
const US_STATE_NAMES: ReadonlySet<string> = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
  'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming', 'district of columbia', 'puerto rico',
])
/**
 * Place codes that are also a professional or legal suffix ("Smith & Jones,
 * PA", "Jane Lee, MD", "Back in Line, DC", "Ada Fox, PE"): a place only after
 * one word ("Erie, PA"). A longer place written with one ("Silver Spring,
 * MD") is left to label affinity.
 */
const CREDENTIAL_PLACE_CODES: ReadonlySet<string> = new Set(['PA', 'MD', 'DC', 'ND', 'NV', 'MA', 'PE'])
/**
 * First words of a metro area or a neighborhood, a place when one word
 * follows ("Metro Larkfield", "Greater Larkfield", "Downtown Larkfield").
 * Lossy on purpose: a two-word business ("Metro Diner") reads the same way.
 * A longer name ("Metro Roofing Supply") is left to label affinity.
 */
const PLACE_LEAD_WORDS: ReadonlySet<string> = new Set(['metro', 'greater', 'downtown', 'midtown', 'uptown'])
/** Compass words, a place before an abbreviated city ("West LA"). */
const COMPASS_WORDS: ReadonlySet<string> = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'])
/** Last words of a region ("Oakvale County", "Larkfield Area"). */
const REGION_LAST_WORDS: ReadonlySet<string> = new Set(['county', 'parish', 'borough', 'township', 'area', 'region'])

function isConnectorWord(word: string): boolean {
  return NAME_CONNECTOR_WORDS.has(word.toLowerCase())
}

/**
 * True when a name is written the way places are: "City, ST" or "City,
 * State" (`CREDENTIAL_PLACE_CODES` only after one word), "X County" (or
 * Parish, Borough, Township, Area, Region), "Metro X", "Greater X" or
 * "Downtown X" (or Midtown, Uptown) with one word after it, and a compass
 * word before an abbreviated city ("West LA"). A place answers cite next to a
 * local competitor is paired with its site, rises with it and is capitalized,
 * so scoring cannot tell it from a brand. A one-word city ("Larkfield") has
 * no shape; label affinity keeps it out (`hasDomainLabelAffinity`).
 */
function isPlaceShaped(name: string): boolean {
  const comma = name.lastIndexOf(',')
  if (comma !== -1) {
    const after = name.slice(comma + 1).trim().replace(/\.$/, '')
    if (US_STATE_NAMES.has(after.toLowerCase())) return true
    if (PLACE_CODES.has(after) && (!CREDENTIAL_PLACE_CODES.has(after) || !/\s/.test(name.slice(0, comma).trim()))) return true
  }
  const words = name.replace(/,/g, ' ').trim().split(/\s+/)
  if (words.length < 2) return false
  if (REGION_LAST_WORDS.has(words.at(-1)!.toLowerCase())) return true
  if (words.length !== 2) return false
  const first = words[0]!.toLowerCase()
  return PLACE_LEAD_WORDS.has(first) || (COMPASS_WORDS.has(first) && /^\p{Lu}{2,3}$/u.test(words[1]!))
}

function nameWordShaped(word: string): boolean {
  if (isConnectorWord(word)) return true
  const first = [...word.replace(/^["'(‘“]+/, '')][0]
  if (!first) return false
  if (/\p{N}/u.test(first)) return true
  if (/\p{Lu}/u.test(first)) return true
  // A letter with no case (CJK, Thai, Arabic, ...) cannot be capitalized.
  return /\p{L}/u.test(first) && first.toLowerCase() === first.toUpperCase()
}

/**
 * True when one written occurrence reads as a name: every word capitalized,
 * numeric or a connector, and at least one word that is not a connector. "the
 * Spoke Shop" is a name; "roof repair" and "Roof repair" are a phrase.
 */
function isNameCasedOccurrence(words: readonly string[]): boolean {
  return words.some(word => !isConnectorWord(word)) && words.every(nameWordShaped)
}

/**
 * True when a candidate reads as a business name rather than a heading, a
 * stat, a step, a source address or a place: at most
 * `MAX_BUSINESS_NAME_WORDS` words, every word capitalized, numeric or a
 * connector ("of", "the", "&", ...), no `% + ? : / |`, no written host, not
 * opening with a heading word ("Why", "How", "Top", "Your", ...), and not
 * written as a place (`isPlaceShaped`: "Larkfield, CO", "Oakvale County",
 * "Metro Larkfield", "West LA"). A bare number may open it only before a
 * capitalized word that is not a plural count ("1 Spoke Lane" is a name, "24
 * Hours" and "7 Ways to Save" are not).
 */
export function isAutoAliasNameShaped(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed || NON_NAME_CHARACTERS.test(trimmed)) return false
  if (extractDomainsFromText(trimmed).length > 0) return false
  const words = trimmed.split(/\s+/)
  if (words.some(word => HOST_SHAPED.test(word))) return false
  if (words.length > MAX_BUSINESS_NAME_WORDS) return false
  const first = words[0]!
  if (/^\p{N}+$/u.test(first)) {
    const next = words[1]
    if (!next || !/^\p{Lu}/u.test(next) || /\p{Ll}s$/u.test(next)) return false
  }
  if (NON_NAME_LEAD_WORDS.has(first.toLowerCase())) return false
  return words.every(nameWordShaped) && !isPlaceShaped(trimmed)
}

/**
 * A name's words as brand keys, in order, with joined words split at case
 * changes (`TuneSpoke` is `tune` and `spoke`), so every run of them starts
 * and ends on a word boundary.
 */
function affinityWords(name: string): string[] {
  const words: string[] = []
  for (const raw of name.normalize('NFKC').split(/[^\p{L}\p{M}\p{N}]+/u)) {
    for (const part of raw.split(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u)) {
      const key = brandKeyFromText(part)
      if (key) words.push(key)
    }
  }
  return words
}

/** True when consecutive whole words of the name join to exactly the label key. */
function wordsSpellLabel(words: readonly string[], labelKey: string): boolean {
  for (let start = 0; start < words.length; start++) {
    let joined = ''
    for (let end = start; end < words.length && joined.length < labelKey.length; end++) {
      joined += words[end]
      if (joined === labelKey) return true
    }
  }
  return false
}

/**
 * True when two or more of the name's words (3+ letters, not a connector or a
 * legal suffix) sit back to back in the label, the first of them opening it
 * (at `opening`), together they cover at least half of it, and one of them
 * of 4+ letters is not shared by two or more `identityLabelKeys`. Back to
 * back, in any order ("TuneSpoke" for `spoketuneworks`): a word placed
 * further on proves nothing ("Austin Roof Pros" for `roofmaxaustin` shares
 * the opener and a place, with "max" between them).
 */
function wordsCoverLabel(words: readonly string[], labelKey: string, opening: number, identityLabelKeys: readonly string[]): boolean {
  const usable = [...new Set(words)]
    .filter(word => word.length >= 3 && !NAME_CONNECTOR_WORDS.has(word) && !LEGAL_SUFFIX_KEYS.includes(word))
    .sort((left, right) => right.length - left.length)
  const distinctive = (word: string): boolean =>
    word.length >= 4 && identityLabelKeys.filter(key => key.includes(word)).length < 2
  for (const opener of usable) {
    if (!labelKey.startsWith(opener, opening)) continue
    const placed = [opener]
    const placedAt = (at: number) => usable.find(word => !placed.includes(word) && labelKey.startsWith(word, at))
    let end = opening + opener.length
    for (let next = placedAt(end); next; next = placedAt(end)) {
      placed.push(next)
      end += next.length
    }
    if (placed.length < 2 || (end - opening) * 2 < labelKey.length) continue
    if (placed.some(distinctive)) return true
  }
  return false
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0
  for (const char of haystack) {
    if (char === needle[at]) at++
    if (at === needle.length) return true
  }
  return needle.length === 0
}

function withoutLegalSuffix(key: string): string {
  for (const suffix of LEGAL_SUFFIX_KEYS) {
    if (key.length > suffix.length + 3 && key.endsWith(suffix)) return key.slice(0, -suffix.length)
  }
  return key
}

/**
 * True when the name visibly belongs to the competitor's domain:
 * - consecutive whole words of it spell the label ("Spoke Garage Bikes" for
 *   `spokegarage.example`, "QVX Parts" for `qvx.example`); a label that
 *   only spans a word boundary proves nothing ("Roof Rescue" does not spell
 *   `roofr`);
 * - a name of two or more words (not counting connectors and legal
 *   suffixes) opens the label whole, right at its start or after a lead word
 *   (`LABEL_LEAD_WORDS`: "SpokeIQ" for `myspokeiq.example`), and covers at
 *   least half of it (a short word inside a long label, "Get" in
 *   `getgoingbikes.example`, proves nothing, and neither does a name inside
 *   the label that does not open it, "Larkfield" in `velolarkfield.example`);
 * - two or more of its words sit back to back in the label, the first
 *   opening it, and cover at least half of it, one of them distinctive: four
 *   or more letters and not shared by two or more tracked identity labels
 *   (`identityLabelKeys`: the project's and every competitor's, so an
 *   industry word such as "roofing" proves nothing). "TuneSpoke" for
 *   `spoketuneworks.example`, "Gale Shield Roofing" for
 *   `galeshieldrc.example`;
 * - a name of two or more words, without a trailing legal suffix, has a key
 *   that is an in-order subsequence of the label and opens like it: the same
 *   first four characters ("FoamSeal" for `foamandsealworks.example`), or a
 *   first word of three or more characters the label starts with ("AIR
 *   Spokes" for `airinspokes.example`).
 *
 * ONE shared word never does, unless it is the whole label: a place the
 * label opens or ends with ("Detroit" for `detroitroofing.example`, "Austin"
 * for `roofmaxaustin.example`), a neighbouring business sharing only the
 * word the label opens with ("Rim Doctor" for `doctorspokes.example`), or
 * one sharing that word plus a word further on ("Austin Roof Pros" for
 * `roofmaxaustin.example`),
 * is paired with the site, rises with it and is capitalized just like its
 * brand, so it is listed for review instead. That includes a one-word brand
 * shorter than its label ("Acme" for `acmecycles.example`).
 */
export function hasDomainLabelAffinity(
  name: string,
  domain: string,
  identityLabelKeys: readonly string[],
): boolean {
  const labelKey = brandKeyFromText(brandLabelFromDomain(domain) || domain)
  const nameKey = brandKeyFromText(name)
  if (!labelKey || !nameKey) return false
  const words = affinityWords(name)
  if (wordsSpellLabel(words, labelKey)) return true
  // One word that is not the whole label is never enough: "Detroit" opens
  // `detroitroofing` and covers half of it, and is the city.
  const multiWord = words.filter(word => !NAME_CONNECTOR_WORDS.has(word) && !LEGAL_SUFFIX_KEYS.includes(word)).length >= 2
  const openings = [0, ...LABEL_LEAD_WORDS.filter(lead => labelKey.length > lead.length && labelKey.startsWith(lead)).map(lead => lead.length)]
  for (const opening of openings) {
    if (multiWord && labelKey.startsWith(nameKey, opening) && nameKey.length * 2 >= labelKey.length) return true
    if (wordsCoverLabel(words, labelKey, opening, identityLabelKeys)) return true
  }
  if (!multiWord) return false
  const core = withoutLegalSuffix(nameKey)
  if (core.length < 4 || !isSubsequence(core, labelKey)) return false
  if (core.slice(0, 4) === labelKey.slice(0, 4)) return true
  const firstWord = brandKeyFromText(name.trim().split(/\s+/)[0] ?? '')
  return firstWord.length >= 3 && labelKey.startsWith(firstWord)
}

/** `[Name](https://site.example/...)`, or a link whose target is a bare host (`[Name](site.example)`). */
const NAMED_LINK = /\[([^[\]\n]{1,120})\]\(((?:https?:\/\/)?[^\s()]{1,500})\)/g
const WRITTEN_HOST = String.raw`(?:https?:\/\/)?(?:www\.)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,63})`
/** `Name (host.example)` */
const PARENTHETICAL_HOST = new RegExp(String.raw`\(\s*${WRITTEN_HOST}\/?\s*\)`, 'gu')
/** `Name - host.example` (hyphen, en dash or em dash) */
const DASHED_HOST = new RegExp(String.raw`\s[-–—]\s+${WRITTEN_HOST}(?![\p{L}\p{N}.-])`, 'gu')

/** The run of name-shaped words that ends `text` (at most `MAX_BUSINESS_NAME_WORDS`). */
function trailingName(text: string): string {
  const tokens = text
    .replace(/[*_`"“”]+/g, ' ')
    .replace(/[\s:;,.|–—-]+$/u, '')
    .split(/\s+/)
    .map(token => token.replace(/^[([{]+|[)\]}]+$/g, ''))
    .filter(Boolean)
  const run: string[] = []
  for (let i = tokens.length - 1; i >= 0 && run.length < MAX_BUSINESS_NAME_WORDS; i--) {
    const token = tokens[i]!
    if (!nameWordShaped(token)) break
    run.unshift(token)
  }
  while (run.length > 0 && isConnectorWord(run[0]!)) run.shift()
  return cleanBusinessNameCandidate(run.join(' '))
}

/**
 * Pairings the answer TEXT writes itself, for every provider: named markdown
 * links whose label is a name, not a source address (`isCitationLabel`), and
 * a name followed by its host in parentheses or after a dash. Links inside a
 * citation chip are citations and are skipped.
 */
export function extractAnswerTextAnchors(answerText: string | null | undefined): AnchoredAnswerSpan[] {
  if (!answerText) return []
  const spans: AnchoredAnswerSpan[] = []
  const text = stripCitationChips(answerText)
  if (text.includes('](')) {
    for (const match of text.matchAll(NAMED_LINK)) {
      const label = match[1]!
      const target = match[2]!
      if (isCitationLabel(label)) continue
      // A relative or in-page target names no site.
      if (!/^https?:\/\//i.test(target) && !HOST_SHAPED.test(target)) continue
      const name = cleanBusinessNameCandidate(label)
      if (name && !HOST_SHAPED.test(name)) spans.push({ text: name, source: target, kind: 'name', via: AnchoredSpanSources['answer-link'] })
    }
  }
  for (const pattern of [PARENTHETICAL_HOST, DASHED_HOST]) {
    for (const match of text.matchAll(pattern)) {
      // `[label](https://host/)` is a markdown link target, not prose.
      if (text[match.index - 1] === ']') continue
      const host = match[1]!.toLowerCase()
      if (!registrableDomain(host)) continue
      const lineStart = text.lastIndexOf('\n', match.index - 1) + 1
      const name = trailingName(text.slice(lineStart, match.index))
      if (name) spans.push({ text: name, source: host, kind: 'name', via: AnchoredSpanSources['answer-host'] })
    }
  }
  return spans
}

/** One stored answer as detection reads it. */
export interface AutoAliasAnswerInput {
  snapshotId: string
  runId: string
  /**
   * The sweep the answer belongs to; runs that share it count as one sweep
   * toward `AUTO_ALIAS_MIN_RUNS`. The scan passes the run's creation time,
   * which every run of one multi-location sweep shares. Defaults to `runId`.
   */
  sweepKey?: string
  createdAt: string
  answerText: string | null
  citedDomains: readonly string[]
  /** The provider's citation anchors (`extractAnchoredSpans`); the answer text's own pairings are added here. */
  anchors?: readonly AnchoredAnswerSpan[]
  /**
   * The `scoped` competitors (by domain) this answer measures: an Advanced
   * market competitor is in scope only for answers to its markets' questions.
   * Every unscoped competitor is in scope for every answer.
   */
  scopedCompetitors?: readonly string[]
}

/**
 * Options for scoring: the competitors' current auto names, scored even
 * without a pairing in the window, and part of the identity a shorter
 * candidate is measured outside of.
 */
export interface AutoAliasFinishOptions {
  storedNames?: readonly { domain: string; name: string }[]
}

/**
 * Answers scored between pauses in `finishInChunks`. Each answer is matched
 * against every candidate key, so 50 keeps a pause under about 80ms on
 * projects with 20-odd competitors.
 */
const AUTO_ALIAS_SCORE_CHUNK = 50

/** A tracked competitor as detection reads it. */
export interface AutoAliasCompetitorInput {
  domain: string
  /**
   * Measured only by the answers that list it in `scopedCompetitors` (a
   * competitor an Advanced market pins without tracking it project-wide).
   * Its evidence, precision and lift then count only those answers: an answer
   * from another market neither pairs it, names it, nor cites it, and another
   * competitor's pairings there do not count against it.
   */
  scoped?: boolean
  /**
   * Its curated aliases (for a market competitor, its plan label and
   * aliases). A candidate written only inside one of them, or inside the
   * domain label or a longer stored name, is not counted as naming it.
   */
  aliases?: readonly string[]
}

export type AutoAliasCandidateRejection =
  | 'name-shape'
  | 'too-few-pairs'
  | 'too-few-runs'
  | 'too-few-naming-answers'
  | 'low-precision'
  | 'low-lift'
  | 'lowercase-usage'
  | 'other-competitor-dominates'

/** Everything the stored answers say about one name for one competitor. */
export interface AutoAliasEvidence {
  name: string
  key: string
  directPairs: number
  /** Distinct sweeps among the pairing answers (`AUTO_ALIAS_MIN_RUNS`). */
  runs: number
  cooccurrences: number
  namingAnswers: number
  citingAnswers: number
  /** Naming answers that write the name capitalized as a name at least once. */
  nameCasedAnswers: number
  /** citingAnswers / namingAnswers, at wire precision; null with no naming answer. */
  precision: number | null
  /**
   * Precision over the competitor's Laplace-smoothed citation rate in the
   * scanned answers that do not name it, to 2 decimals; null with no naming
   * answer.
   */
  lift: number | null
  /** The most direct pairs any other tracked competitor has for this name, in the answers that measure this one. */
  otherCompetitorPairs: number
  via: AnchoredSpanSource[]
  firstSeen: string
  lastSeen: string
  labelAffinity: boolean
  /** The first rule the name fails before label affinity and the key floor; null when it passes them all. */
  rejection: AutoAliasCandidateRejection | null
}

export interface AutoAliasScores {
  /** Evidence per normalized competitor domain, keyed by brand key. */
  byCompetitor: Map<string, Map<string, AutoAliasEvidence>>
  answers: number
}

interface PairStats {
  answers: Set<string>
  sweeps: Set<string>
  spellings: Map<string, number>
  via: Set<AnchoredSpanSource>
  firstSeen: string
  lastSeen: string
}

/** A match's first and last word, as indexes into `brandWords` of the text. */
type WordSpan = readonly [number, number]

/**
 * Where each of `keys` is written as complete adjacent words: the walk
 * `matchedAliasKeys` makes over the same words (`brandWords`), keeping each
 * match's position so a match inside a longer one can be told apart.
 */
function keySpans(words: readonly string[], keys: ReadonlySet<string>, longest: number): Map<string, WordSpan[]> {
  const spans = new Map<string, WordSpan[]>()
  for (let start = 0; start < words.length; start++) {
    let candidate = ''
    for (let end = start; end < words.length; end++) {
      candidate += words[end]
      if (keys.has(candidate)) {
        const found = spans.get(candidate)
        if (found) found.push([start, end])
        else spans.set(candidate, [[start, end]])
      }
      if (candidate.length >= longest) break
    }
  }
  return spans
}

/** Lift to 2 decimals (a multiple, not a ratio unit). */
function roundLift(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Collects evidence answer by answer, so a caller can stream stored rows and
 * drop each raw response once its anchors are read, then scores every
 * candidate in one pass (`finish`). Pure: no I/O.
 */
export function createAutoAliasAccumulator(input: {
  competitors: readonly AutoAliasCompetitorInput[]
  project: CompetitorAliasProjectIdentity
}) {
  const competitors = input.competitors.map(competitor => ({
    domain: competitor.domain,
    key: normalizeCompetitorDomain(competitor.domain),
    host: hostOf(competitor.domain),
    scoped: competitor.scoped === true,
    aliases: competitor.aliases ?? [],
  }))
  const scopedIndexByKey = new Map(competitors.flatMap((competitor, index) => competitor.scoped ? [[competitor.key, index] as const] : []))
  const projectDomains = input.project.domains
  const projectHosts = projectDomains.map(domain => hostOf(domain)).filter((host): host is string => host !== null)
  /** `hostMatchesDomain` with the domain side parsed once: the same host, or a subdomain of it. */
  const hostIsOrUnder = (host: string, domainHost: string | null): boolean =>
    domainHost !== null && (host === domainHost || host.endsWith(`.${domainHost}`))
  const identityLabelKeys = [
    ...projectDomains.map(domain => brandKeyFromText(brandLabelFromDomain(domain))),
    ...competitors.map(competitor => brandKeyFromText(brandLabelFromDomain(competitor.domain) || competitor.domain)),
  ].filter(Boolean)
  const pairs = new Map<string, Map<number, PairStats>>()
  const cooccurrences = new Map<string, Map<number, Set<string>>>()
  /** Each scanned answer's prose, the competitors it cites, and its scope (`scopes`). */
  const answers: { prose: string; cited: number[]; scope: number }[] = []
  /**
   * The distinct sets of scoped competitors in scope for an answer, so a
   * count kept per scope sums to any competitor's own population. With no
   * scoped competitor every answer shares scope 0 (the empty set).
   */
  const scopes: Set<number>[] = []
  const scopeIds = new Map<string, number>()
  const answersPerScope: number[] = []
  const scopeOf = (answer: AutoAliasAnswerInput): number => {
    const indexes = [...new Set((answer.scopedCompetitors ?? [])
      .map(domain => scopedIndexByKey.get(normalizeCompetitorDomain(domain)))
      .filter((index): index is number => index !== undefined))].sort((left, right) => left - right)
    const signature = indexes.join(',')
    let id = scopeIds.get(signature)
    if (id === undefined) {
      id = scopes.length
      scopeIds.set(signature, id)
      scopes.push(new Set(indexes))
      answersPerScope.push(0)
    }
    return id
  }
  const inScope = (index: number, scope: number): boolean => !competitors[index]!.scoped || scopes[scope]!.has(index)
  /** Scanned answers that cite each competitor, the base of every lift. */
  const citingTotals = competitors.map(() => 0)
  /** Each scanned answer's scope, by snapshot id, so another competitor's pairs count only where this one is measured. */
  const scopeBySnapshot = new Map<string, number>()

  const hostCache = new Map<string, string | null>()
  const cachedHostOf = (value: string): string | null => {
    let host = hostCache.get(value)
    if (host === undefined) {
      host = hostOf(value)
      if (hostCache.size > 50_000) hostCache.clear()
      hostCache.set(value, host)
    }
    return host
  }
  const competitorsAt = (source: string, scope: number): number[] => {
    const host = cachedHostOf(source)
    if (!host || projectHosts.some(projectHost => hostIsOrUnder(host, projectHost))) return []
    const matched: number[] = []
    competitors.forEach((competitor, index) => {
      if (inScope(index, scope) && hostIsOrUnder(host, competitor.host)) matched.push(index)
    })
    return matched
  }

  const recordPair = (key: string, name: string, index: number, answer: AutoAliasAnswerInput, via: AnchoredSpanSource) => {
    let byCompetitor = pairs.get(key)
    if (!byCompetitor) pairs.set(key, byCompetitor = new Map<number, PairStats>())
    let stats = byCompetitor.get(index)
    if (!stats) {
      byCompetitor.set(index, stats = {
        answers: new Set(),
        sweeps: new Set(),
        spellings: new Map(),
        via: new Set(),
        firstSeen: answer.createdAt,
        lastSeen: answer.createdAt,
      })
    }
    stats.answers.add(answer.snapshotId)
    stats.sweeps.add(answer.sweepKey ?? answer.runId)
    stats.spellings.set(name, (stats.spellings.get(name) ?? 0) + 1)
    stats.via.add(via)
    if (answer.createdAt < stats.firstSeen) stats.firstSeen = answer.createdAt
    if (answer.createdAt > stats.lastSeen) stats.lastSeen = answer.createdAt
  }

  /** The scoring pass behind `finish`, pausing (`yield`) between chunks of answers. */
  function* scoreSteps(opts: AutoAliasFinishOptions): Generator<void, AutoAliasScores> {
    const storedByIndex = competitors.map(() => [] as string[])
    for (const stored of opts.storedNames ?? []) {
      const key = brandKeyFromText(stored.name)
      const index = competitors.findIndex(competitor => competitor.key === normalizeCompetitorDomain(stored.domain))
      if (!key || index === -1) continue
      storedByIndex[index]!.push(stored.name)
      let byCompetitor = pairs.get(key)
      if (!byCompetitor) pairs.set(key, byCompetitor = new Map<number, PairStats>())
      if (!byCompetitor.has(index)) {
        byCompetitor.set(index, { answers: new Set(), sweeps: new Set(), spellings: new Map([[stored.name, 0]]), via: new Set(), firstSeen: '', lastSeen: '' })
      }
    }
    const storedKeys = new Set((opts.storedNames ?? []).map(stored => brandKeyFromText(stored.name)))
    const keys = [...pairs.entries()]
      .filter(([key, paired]) => storedKeys.has(key) || [...paired.values()].some(stats => stats.answers.size >= AUTO_ALIAS_MIN_DIRECT_ANSWERS))
      .map(([key]) => key)
    const scored = new Set(keys)
    // A name written only inside a longer name of the same competitor says
    // nothing on its own: an answer that writes "Lark Bay Suites" names that
    // brand, not the shorter "Lark Bay" (often the place), so counting it
    // would hand the truncation the brand's precision and lift. Per scored
    // key, the competitors whose own identity (domain label, the `aliases`
    // passed in, stored names) has a longer key containing it.
    const identityKeys = competitors.map((competitor, index) => [...new Set(
      [...competitorNameAliases({ domain: competitor.domain, aliases: competitor.aliases }), ...storedByIndex[index]!]
        .map(brandKeyFromText)
        .filter(Boolean),
    )])
    const longerIdentity = new Map<string, Map<number, string[]>>()
    const spanKeys = new Set(keys)
    for (const key of keys) {
      for (const index of pairs.get(key)!.keys()) {
        const longer = identityKeys[index]!.filter(identity => identity.length > key.length && identity.includes(key))
        if (longer.length === 0) continue
        let byCompetitor = longerIdentity.get(key)
        if (!byCompetitor) longerIdentity.set(key, byCompetitor = new Map<number, string[]>())
        byCompetitor.set(index, longer)
        for (const identity of longer) spanKeys.add(identity)
      }
    }
    let spanLongest = 0
    for (const key of spanKeys) spanLongest = Math.max(spanLongest, key.length)
    // Per scope, so each competitor sums only the answers it is measured by.
    const naming = new Map<string, number[]>()
    const nameCased = new Map<string, number[]>()
    const countIn = (counts: Map<string, number[]>, key: string, scope: number): void => {
      let perScope = counts.get(key)
      if (!perScope) counts.set(key, perScope = scopes.map(() => 0))
      perScope[scope]!++
    }
    // Per key and competitor: naming (and name-cased) answers that are not
    // naming answers for that competitor, because every occurrence (or every
    // name-cased one) sits inside its longer identity.
    const maskedNaming = new Map<string, Map<number, number[]>>()
    const maskedNameCased = new Map<string, Map<number, number[]>>()
    const countMasked = (counts: Map<string, Map<number, number[]>>, key: string, index: number, scope: number): void => {
      let byCompetitor = counts.get(key)
      if (!byCompetitor) counts.set(key, byCompetitor = new Map<number, number[]>())
      let perScope = byCompetitor.get(index)
      if (!perScope) byCompetitor.set(index, perScope = scopes.map(() => 0))
      perScope[scope]!++
    }
    const citing = new Map<string, Map<number, number>>()
    if (keys.length > 0) {
      // Keys are brand keys, so each one compiles to itself.
      const matcher = compileBrandAliases(keys)
      for (let at = 0; at < answers.length; at++) {
        if (at > 0 && at % AUTO_ALIAS_SCORE_CHUNK === 0) yield
        const answer = answers[at]!
        const found = matchedAliasKeys(matcher, answer.prose)
        if (found.size === 0) continue
        const occurrences = aliasOccurrencesAsWritten(matcher, answer.prose)
        let spans: Map<string, WordSpan[]> | undefined
        for (const key of found) {
          const written = occurrences.get(key) ?? []
          const cased = written.some(isNameCasedOccurrence)
          countIn(naming, key, answer.scope)
          if (cased) countIn(nameCased, key, answer.scope)
          for (const index of pairs.get(key)!.keys()) {
            const longer = longerIdentity.get(key)?.get(index)
            if (longer) {
              spans ??= keySpans(brandWords(answer.prose), spanKeys, spanLongest)
              const own = spans.get(key) ?? []
              const outer = longer.flatMap(identity => spans!.get(identity) ?? [])
              const standalone = own.flatMap(([start, end], position) =>
                outer.some(([outerStart, outerEnd]) => outerStart <= start && end <= outerEnd) ? [] : [position])
              if (own.length > 0 && standalone.length === 0) {
                countMasked(maskedNaming, key, index, answer.scope)
                if (cased) countMasked(maskedNameCased, key, index, answer.scope)
                continue
              }
              // The written occurrences come from the same walk, so when they
              // line up, casing reads only the ones written on their own.
              if (cased && written.length === own.length && !standalone.some(position => isNameCasedOccurrence(written[position]!))) {
                countMasked(maskedNameCased, key, index, answer.scope)
              }
            }
            if (!answer.cited.includes(index)) continue
            let counts = citing.get(key)
            if (!counts) citing.set(key, counts = new Map<number, number>())
            counts.set(index, (counts.get(index) ?? 0) + 1)
          }
        }
      }
    }

    /** One competitor's share of a per-scope count: the scopes it is measured in. */
    const sumInScope = (perScope: readonly number[] | undefined, index: number): number => {
      let total = 0
      perScope?.forEach((count, scope) => { if (inScope(index, scope)) total += count })
      return total
    }
    const byCompetitor = new Map<string, Map<string, AutoAliasEvidence>>()
    for (const [key, paired] of pairs) {
      if (!scored.has(key)) continue
      for (const [index, stats] of paired) {
        const competitor = competitors[index]!
        const name = preferredSpelling(stats.spellings)
        const namingAnswers = sumInScope(naming.get(key), index) - sumInScope(maskedNaming.get(key)?.get(index), index)
        const citingAnswers = citing.get(key)?.get(index) ?? 0
        const precision = namingAnswers > 0 ? roundRatio(citingAnswers / namingAnswers, RatioUnits.fraction) : null
        // Laplace-smoothed, so a name every answer carries (no answers left
        // to contrast with) cannot claim a lift. Over the answers that
        // measure this competitor only.
        const measuredAnswers = sumInScope(answersPerScope, index)
        const baseRate = (citingTotals[index]! - citingAnswers + 1) / (measuredAnswers - namingAnswers + 2)
        const lift = namingAnswers > 0 ? roundLift((citingAnswers / namingAnswers) / baseRate) : null
        // Another competitor's pairs count only in the answers that measure
        // this one: two market competitors in separate markets that share a
        // name never outweigh each other (the identity rules still give
        // the name to neither).
        let otherCompetitorPairs = 0
        for (const [other, otherStats] of paired) {
          if (other === index) continue
          let shared = 0
          for (const snapshotId of otherStats.answers) {
            const scope = scopeBySnapshot.get(snapshotId)
            if (scope !== undefined && inScope(index, scope)) shared++
          }
          otherCompetitorPairs = Math.max(otherCompetitorPairs, shared)
        }
        const evidence: AutoAliasEvidence = {
          name,
          key,
          directPairs: stats.answers.size,
          runs: stats.sweeps.size,
          cooccurrences: cooccurrences.get(key)?.get(index)?.size ?? 0,
          namingAnswers,
          citingAnswers,
          nameCasedAnswers: sumInScope(nameCased.get(key), index) - sumInScope(maskedNameCased.get(key)?.get(index), index),
          precision,
          lift,
          otherCompetitorPairs,
          via: [...stats.via].sort(),
          firstSeen: stats.firstSeen,
          lastSeen: stats.lastSeen,
          // A stored name is judged as stored: answers that write "TuneSpoke"
          // as "Tunespoke" say nothing about its words.
          labelAffinity: hasDomainLabelAffinity(
            storedByIndex[index]!.find(storedName => brandKeyFromText(storedName) === key) ?? name,
            competitor.domain,
            identityLabelKeys,
          ),
          rejection: null,
        }
        evidence.rejection = candidateRejection(evidence)
        let entry = byCompetitor.get(competitor.key)
        if (!entry) byCompetitor.set(competitor.key, entry = new Map<string, AutoAliasEvidence>())
        entry.set(key, evidence)
      }
    }
    return { byCompetitor, answers: answers.length }
  }

  return {
    add(answer: AutoAliasAnswerInput): void {
      if (!answer.answerText) return
      const scope = scopeOf(answer)
      answersPerScope[scope]!++
      scopeBySnapshot.set(answer.snapshotId, scope)
      const citedHosts = answer.citedDomains.map(cachedHostOf).filter((host): host is string => host !== null)
      const cited: number[] = []
      competitors.forEach((competitor, index) => {
        if (inScope(index, scope) && citedHosts.some(host => hostIsOrUnder(host, competitor.host))) cited.push(index)
      })
      for (const index of cited) citingTotals[index]!++
      for (const anchor of [...(answer.anchors ?? []), ...extractAnswerTextAnchors(answer.answerText)]) {
        const matched = competitorsAt(anchor.source, scope)
        if (matched.length === 0) continue
        const names = anchor.kind === 'name' ? [cleanBusinessNameCandidate(anchor.text)] : extractBusinessNameCandidates(anchor.text)
        for (const name of names) {
          const key = brandKeyFromText(name)
          if (key.length < MIN_BRAND_ALIAS_KEY_LENGTH) continue
          for (const index of matched) recordPair(key, name, index, answer, anchor.via)
        }
      }
      if (cited.length > 0) {
        for (const name of extractBusinessNameCandidates(answer.answerText)) {
          const key = brandKeyFromText(name)
          if (key.length < MIN_BRAND_ALIAS_KEY_LENGTH) continue
          let byCompetitor = cooccurrences.get(key)
          if (!byCompetitor) cooccurrences.set(key, byCompetitor = new Map<number, Set<string>>())
          for (const index of cited) {
            let seen = byCompetitor.get(index)
            if (!seen) byCompetitor.set(index, seen = new Set())
            seen.add(answer.snapshotId)
          }
        }
      }
      answers.push({ prose: answerProseForMentions(answer.answerText), cited, scope })
    },

    /**
     * Score every candidate. Precision, lift and name casing are computed
     * only where they can matter: names some competitor pairs in at least
     * `AUTO_ALIAS_MIN_DIRECT_ANSWERS` answers, plus `storedNames` (a
     * competitor's current auto names), which get evidence even with no
     * pairing in the scanned window so a stored name the answers now
     * contradict can be removed.
     */
    finish(opts: AutoAliasFinishOptions = {}): AutoAliasScores {
      const steps = scoreSteps(opts)
      let step = steps.next()
      while (!step.done) step = steps.next()
      return step.value
    },

    /** `finish`, awaiting `pause` every `AUTO_ALIAS_SCORE_CHUNK` answers so a host can yield its event loop. */
    async finishInChunks(pause: () => Promise<void>, opts: AutoAliasFinishOptions = {}): Promise<AutoAliasScores> {
      const steps = scoreSteps(opts)
      let step = steps.next()
      while (!step.done) {
        await pause()
        step = steps.next()
      }
      return step.value
    },
  }
}

function preferredSpelling(spellings: ReadonlyMap<string, number>): string {
  let best = ''
  let bestCount = -1
  for (const [spelling, count] of spellings) {
    if (count > bestCount) {
      best = spelling
      bestCount = count
    }
  }
  return best
}

function candidateRejection(evidence: AutoAliasEvidence): AutoAliasCandidateRejection | null {
  if (!isAutoAliasNameShaped(evidence.name)) return 'name-shape'
  if (evidence.directPairs < AUTO_ALIAS_MIN_DIRECT_ANSWERS) return 'too-few-pairs'
  if (evidence.runs < AUTO_ALIAS_MIN_RUNS) return 'too-few-runs'
  if (evidence.namingAnswers < AUTO_ALIAS_MIN_NAMING_ANSWERS) return 'too-few-naming-answers'
  if (evidence.precision === null || evidence.precision < AUTO_ALIAS_MIN_PRECISION) return 'low-precision'
  if (evidence.lift === null || evidence.lift < AUTO_ALIAS_MIN_LIFT) return 'low-lift'
  if (evidence.nameCasedAnswers < AUTO_ALIAS_MIN_NAME_CASED_SHARE * evidence.namingAnswers) return 'lowercase-usage'
  if (evidence.directPairs < AUTO_ALIAS_DOMINANCE_RATIO * evidence.otherCompetitorPairs) return 'other-competitor-dominates'
  return null
}

/**
 * Where a name that passes every scoring rule stands before the identity
 * plan: applied, or listed for review because nothing ties it to the domain
 * (`no-label-affinity`) or its key is under the domain-label floor
 * (`needs-approval`).
 */
function passingStatus(evidence: AutoAliasEvidence): 'apply' | 'needs-approval' | 'no-label-affinity' | null {
  if (evidence.rejection !== null) return null
  if (!evidence.labelAffinity) return 'no-label-affinity'
  if (evidence.key.length < AUTO_ALIAS_MIN_KEY_LENGTH) return 'needs-approval'
  return 'apply'
}

export const competitorAutoAliasSchema = z.object({
  name: z.string(),
  /** Distinct answers whose citation structure paired the name with this competitor's site. */
  directPairs: z.number().int().nonnegative(),
  /** Distinct answers that cite this competitor and lay the name out as a business elsewhere. */
  cooccurrences: z.number().int().nonnegative(),
  /** Scanned answers whose prose names it (the precision denominator). */
  namingAnswers: z.number().int().nonnegative(),
  /** Of the naming answers, the share that cite this competitor's domain. */
  precision: fraction(z.number().min(0).max(1)),
  /**
   * Precision over this competitor's smoothed citation rate in the answers
   * that do not name it. Absent on a record stored before lift was recorded.
   */
  lift: z.number().nonnegative().nullable().optional(),
  /** Naming answers that write it capitalized as a name. Absent on a record stored before it was recorded. */
  nameCasedAnswers: z.number().int().nonnegative().optional(),
  /** Distinct sweeps among the pairing answers (runs started together count once). */
  runs: z.number().int().nonnegative(),
  /** Earliest and latest pairing answer. */
  firstSeen: z.string(),
  lastSeen: z.string(),
  /** When detection applied the name. */
  addedAt: z.string(),
})

/** One stored auto-detected competitor name with its evidence (`competitors.auto_aliases`). */
export type CompetitorAutoAlias = z.infer<typeof competitorAutoAliasSchema>

export const competitorAutoAliasStatusSchema = z.enum(['added', 'kept', 'removed', 'review', 'rejected'])
export type CompetitorAutoAliasStatus = z.infer<typeof competitorAutoAliasStatusSchema>

export const competitorAutoAliasReasonSchema = z.enum([
  'name-shape',
  'too-few-pairs',
  'too-few-runs',
  'too-few-naming-answers',
  'low-precision',
  'low-lift',
  'lowercase-usage',
  'other-competitor-dominates',
  'no-label-affinity',
  'needs-approval',
  'subsumed',
  'too-long',
  'too-short',
  'blocked',
  'already-matched',
  'project-brand',
  'other-competitor',
  'over-limit',
])
export type CompetitorAutoAliasReason = z.infer<typeof competitorAutoAliasReasonSchema>

export const competitorAutoAliasCandidateSchema = z.object({
  name: z.string(),
  status: competitorAutoAliasStatusSchema,
  /** Why the name is not applied (or was removed); absent for added and kept names. */
  reason: competitorAutoAliasReasonSchema.optional(),
  /** The other competitor involved in an 'other-competitor' reason. */
  conflictsWith: z.string().optional(),
  directPairs: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  cooccurrences: z.number().int().nonnegative(),
  namingAnswers: z.number().int().nonnegative(),
  citingAnswers: z.number().int().nonnegative(),
  nameCasedAnswers: z.number().int().nonnegative(),
  precision: fraction(z.number().min(0).max(1)).nullable(),
  lift: z.number().nonnegative().nullable(),
  otherCompetitorPairs: z.number().int().nonnegative(),
  labelAffinity: z.boolean(),
  via: z.array(anchoredSpanSourceSchema),
  firstSeen: z.string(),
  lastSeen: z.string(),
})
export type CompetitorAutoAliasCandidate = z.infer<typeof competitorAutoAliasCandidateSchema>

/** One stored competitor as a detection pass resolves it. */
export interface CompetitorAutoAliasState {
  domain: string
  aliases: readonly string[]
  autoAliases: readonly CompetitorAutoAlias[]
  blockedAliases: readonly string[]
}

export interface CompetitorAutoAliasResolution {
  domain: string
  /** The stored auto names after this pass, with refreshed evidence. */
  autoAliases: CompetitorAutoAlias[]
  added: string[]
  removed: { name: string; reason: CompetitorAutoAliasReason; conflictsWith?: string }[]
  /** Candidates worth showing: added, kept, removed, review, and the strongest rejections. */
  candidates: CompetitorAutoAliasCandidate[]
  /** True when the set of names differs from the stored one. */
  namesChanged: boolean
  /** True when anything stored differs (names or evidence). */
  recordsChanged: boolean
}

function candidateFromEvidence(
  evidence: AutoAliasEvidence,
  status: CompetitorAutoAliasStatus,
  reason?: CompetitorAutoAliasReason,
  conflictsWith?: string,
): CompetitorAutoAliasCandidate {
  return {
    name: evidence.name,
    status,
    ...(reason ? { reason } : {}),
    ...(conflictsWith ? { conflictsWith } : {}),
    directPairs: evidence.directPairs,
    runs: evidence.runs,
    cooccurrences: evidence.cooccurrences,
    namingAnswers: evidence.namingAnswers,
    citingAnswers: evidence.citingAnswers,
    nameCasedAnswers: evidence.nameCasedAnswers,
    precision: evidence.precision,
    lift: evidence.lift,
    otherCompetitorPairs: evidence.otherCompetitorPairs,
    labelAffinity: evidence.labelAffinity,
    via: evidence.via,
    firstSeen: evidence.firstSeen,
    lastSeen: evidence.lastSeen,
  }
}

/**
 * A stored name as a candidate. `window`, when the scan saw the name without
 * pairing it, supplies the naming measures the scan did take; the pairing
 * evidence and its dates stay the stored ones.
 */
function candidateFromStored(
  record: CompetitorAutoAlias,
  status: CompetitorAutoAliasStatus,
  reason?: CompetitorAutoAliasReason,
  conflictsWith?: string,
  window?: AutoAliasEvidence,
): CompetitorAutoAliasCandidate {
  const namingAnswers = window?.namingAnswers ?? record.namingAnswers
  return {
    name: record.name,
    status,
    ...(reason ? { reason } : {}),
    ...(conflictsWith ? { conflictsWith } : {}),
    directPairs: record.directPairs,
    runs: record.runs,
    cooccurrences: record.cooccurrences,
    namingAnswers,
    citingAnswers: window?.citingAnswers ?? Math.round(record.precision * record.namingAnswers),
    nameCasedAnswers: window?.nameCasedAnswers ?? record.nameCasedAnswers ?? 0,
    precision: window ? window.precision : record.precision,
    lift: window ? window.lift : record.lift ?? null,
    otherCompetitorPairs: window?.otherCompetitorPairs ?? 0,
    labelAffinity: window?.labelAffinity ?? true,
    via: [],
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
  }
}

function strongestFirst(a: AutoAliasEvidence, b: AutoAliasEvidence): number {
  return b.directPairs - a.directPairs
    || (b.precision ?? 0) - (a.precision ?? 0)
    || a.name.localeCompare(b.name)
}

function sameRecords(a: readonly CompetitorAutoAlias[], b: readonly CompetitorAutoAlias[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A rule that removes a stored name (`contradiction`). */
type StoredNameContradiction = 'low-precision' | 'low-lift' | 'lowercase-usage' | 'other-competitor-dominates' | 'no-label-affinity'

/**
 * The rule a stored name's window evidence clearly contradicts, or null:
 * precision, lift or name casing below the REMOVE bounds (with at least
 * `AUTO_ALIAS_MIN_NAMING_ANSWERS` answers naming it); another tracked
 * competitor now pairing it in at least `AUTO_ALIAS_MIN_DIRECT_ANSWERS`
 * answers and at least `AUTO_ALIAS_DOMINANCE_RATIO` times as many as this
 * one (a neighbour's name captured before its own site was tracked); or no
 * label affinity against the current identity labels (a newly tracked label
 * now shares its word).
 */
function contradiction(seen: AutoAliasEvidence | undefined): StoredNameContradiction | null {
  if (!seen) return null
  if (seen.namingAnswers >= AUTO_ALIAS_MIN_NAMING_ANSWERS) {
    if ((seen.precision ?? 0) < AUTO_ALIAS_REMOVE_BELOW_PRECISION) return 'low-precision'
    if ((seen.lift ?? 0) < AUTO_ALIAS_REMOVE_BELOW_LIFT) return 'low-lift'
    if (seen.nameCasedAnswers < AUTO_ALIAS_REMOVE_BELOW_NAME_CASED_SHARE * seen.namingAnswers) return 'lowercase-usage'
  }
  if (seen.otherCompetitorPairs >= AUTO_ALIAS_MIN_DIRECT_ANSWERS
    && seen.otherCompetitorPairs >= AUTO_ALIAS_DOMINANCE_RATIO * seen.directPairs) return 'other-competitor-dominates'
  if (!seen.labelAffinity) return 'no-label-affinity'
  return null
}

/** A passing name listed for an operator to verify rather than applied (`passingStatus`). */
function isReviewStatus(evidence: AutoAliasEvidence): boolean {
  const status = passingStatus(evidence)
  return status === 'needs-approval' || status === 'no-label-affinity'
}

/**
 * Merge a scan's scores into every competitor's stored state. Stored names are
 * STICKY: a name stays until the operator blocks it, the shared identity
 * rules claim it (the competitor's own curated identity already matches it,
 * it overlaps the project's names or hosts, another competitor's domain
 * label, host or curated alias, a market pin of another domain, or another
 * competitor's stored auto name that comes earlier in `competitors` order),
 * a newly accepted shorter name it is built on replaces it, or the scanned
 * answers clearly contradict it (`contradiction`: precision, lift or name
 * casing below the lower REMOVE bounds with at least
 * `AUTO_ALIAS_MIN_NAMING_ANSWERS` naming answers, another tracked competitor
 * now pairing it in at least `AUTO_ALIAS_MIN_DIRECT_ANSWERS` answers and at
 * least `AUTO_ALIAS_DOMINANCE_RATIO` times as often, or no label affinity
 * left). A name the window no longer mentions keeps its last
 * evidence, so a bounded scan never churns stored identity. New names are the
 * candidates that pass every rule, strongest evidence first (the cap keeps
 * the strongest), through `planCompetitorAutoAliases`, which lets a passing
 * short name subsume the longer ones built on it and drops a blocked name
 * before it can subsume anything.
 *
 * Competitors are resolved in `competitors` order, which decides which of two
 * competitors' STORED names wins when an identity change makes them overlap;
 * the scan passes tracked competitors first, then market-only ones, each sorted by domain.
 */
export function resolveCompetitorAutoAliases(
  scores: AutoAliasScores,
  competitors: readonly CompetitorAutoAliasState[],
  project: CompetitorAliasProjectIdentity,
  now: string,
  /**
   * The competitors the project's Advanced markets pin: no competitor learns
   * or keeps a name a pin of another domain answers to
   * (`planCompetitorAutoAliases`).
   */
  marketPins: readonly CompetitorAliasMarketPin[] = [],
): CompetitorAutoAliasResolution[] {
  const evidenceFor = (domain: string) => scores.byCompetitor.get(normalizeCompetitorDomain(domain)) ?? new Map<string, AutoAliasEvidence>()
  const contradicted = competitors.map(competitor => new Map(competitor.autoAliases.flatMap((record) => {
    const rule = contradiction(evidenceFor(competitor.domain).get(brandKeyFromText(record.name)))
    return rule ? [[brandKeyFromText(record.name), rule] as const] : []
  })))
  const entries = competitors.map((competitor, index) => {
    const evidence = [...evidenceFor(competitor.domain).values()]
    const storedKeys = new Set(competitor.autoAliases.map(record => brandKeyFromText(record.name)))
    const fresh = evidence.filter(item => !storedKeys.has(item.key)).sort(strongestFirst)
    return {
      domain: competitor.domain,
      aliases: competitor.aliases,
      autoAliases: competitor.autoAliases
        .map(record => record.name)
        .filter(name => !contradicted[index]!.has(brandKeyFromText(name))),
      // Strongest first: the plan fills the cap in this order.
      candidates: fresh.filter(item => passingStatus(item) === 'apply').map(item => item.name),
      review: fresh.filter(item => item.directPairs > 0 && isReviewStatus(item)).map(item => item.name),
      blockedAliases: competitor.blockedAliases,
    }
  })
  const plan = planCompetitorAutoAliases(entries, project, marketPins)

  return competitors.map((competitor, index) => {
    const evidence = evidenceFor(competitor.domain)
    const planned = plan.competitors[index]!.autoAliases
    const drops = plan.dropped.filter(drop => normalizeCompetitorDomain(drop.domain) === normalizeCompetitorDomain(competitor.domain))
    const storedByKey = new Map(competitor.autoAliases.map(record => [brandKeyFromText(record.name), record]))
    const autoAliases: CompetitorAutoAlias[] = planned.map((name) => {
      const key = brandKeyFromText(name)
      const stored = storedByKey.get(key)
      const seen = evidence.get(key)
      // No pairing in the scanned window: the stored evidence stands.
      if (stored && (!seen || seen.directPairs === 0)) return stored
      if (stored && seen) {
        return {
          name: stored.name,
          directPairs: seen.directPairs,
          cooccurrences: seen.cooccurrences,
          namingAnswers: seen.namingAnswers,
          precision: seen.precision ?? stored.precision,
          lift: seen.lift,
          nameCasedAnswers: seen.nameCasedAnswers,
          runs: seen.runs,
          firstSeen: stored.firstSeen && stored.firstSeen < seen.firstSeen ? stored.firstSeen : seen.firstSeen,
          lastSeen: stored.lastSeen > seen.lastSeen ? stored.lastSeen : seen.lastSeen,
          addedAt: stored.addedAt,
        }
      }
      return {
        name,
        directPairs: seen?.directPairs ?? 0,
        cooccurrences: seen?.cooccurrences ?? 0,
        namingAnswers: seen?.namingAnswers ?? 0,
        precision: seen?.precision ?? 0,
        lift: seen?.lift ?? null,
        nameCasedAnswers: seen?.nameCasedAnswers ?? 0,
        runs: seen?.runs ?? 0,
        firstSeen: seen?.firstSeen ?? now,
        lastSeen: seen?.lastSeen ?? now,
        addedAt: now,
      }
    })
    const plannedKeys = new Set(planned.map(brandKeyFromText))
    const added = planned.filter(name => !storedByKey.has(brandKeyFromText(name)))
    const removed: CompetitorAutoAliasResolution['removed'] = []
    const candidates: CompetitorAutoAliasCandidate[] = []
    const listed = new Set<string>()

    for (const record of competitor.autoAliases) {
      const key = brandKeyFromText(record.name)
      listed.add(key)
      const seen = evidence.get(key)
      const paired = seen !== undefined && seen.directPairs > 0
      if (plannedKeys.has(key)) {
        candidates.push(paired ? candidateFromEvidence(seen, 'kept') : candidateFromStored(record, 'kept', undefined, undefined, seen))
        continue
      }
      const drop = drops.find(item => item.stored && brandKeyFromText(item.alias) === key)
      const reason: CompetitorAutoAliasReason = drop ? drop.reason : contradicted[index]!.get(key) ?? 'low-precision'
      removed.push({ name: record.name, reason, ...(drop?.conflictsWith ? { conflictsWith: drop.conflictsWith } : {}) })
      candidates.push(paired
        ? candidateFromEvidence(seen, 'removed', reason, drop?.conflictsWith)
        : candidateFromStored(record, 'removed', reason, drop?.conflictsWith, seen))
    }
    for (const name of added) {
      const key = brandKeyFromText(name)
      listed.add(key)
      candidates.push(candidateFromEvidence(evidence.get(key)!, 'added'))
    }
    const unlisted = [...evidence.values()].filter(item => !listed.has(item.key) && item.directPairs > 0).sort(strongestFirst)
    // Review names pass the plan's `review` checks: never a name overlapping
    // the project's names or hosts, another competitor's domain label, host
    // or curated alias, or a market pin of another domain, a blocked name,
    // or one the competitor's identity or planned auto names already match
    // as complete words ("Acme Bikes Repair" once "Acme Bikes" is a name).
    // They are not checked against other competitors' auto-detected names,
    // as applied names are. A place written in a place shape ("Larkfield, CO",
    // "Oakvale County", "Metro Larkfield") fails the name shape and never
    // gets here; a one-word city or a longer region phrase has no shape and
    // can still be listed, which is why review names are never applied.
    const reviewKeys = new Set(plan.review[index]!.map(brandKeyFromText))
    const review = unlisted.filter(item => reviewKeys.has(item.key)).slice(0, AUTO_ALIAS_REPORT_LIMIT)
    for (const item of review) candidates.push(candidateFromEvidence(item, 'review', passingStatus(item) as CompetitorAutoAliasReason))
    const reviewed = new Set(review.map(item => item.key))
    // A review name another identity claims is reported as rejected, with
    // the rule; one the competitor already matches adds nothing to report.
    const reviewDrops = new Map(plan.reviewDropped
      .filter(drop => drop.reason !== 'already-matched' && normalizeCompetitorDomain(drop.domain) === normalizeCompetitorDomain(competitor.domain))
      .map(drop => [brandKeyFromText(drop.alias), drop]))
    const rejected = unlisted
      .filter(item => !reviewed.has(item.key) && item.directPairs >= AUTO_ALIAS_MIN_DIRECT_ANSWERS && (item.rejection !== null || passingStatus(item) === 'apply' || reviewDrops.has(item.key)))
      .slice(0, AUTO_ALIAS_REPORT_LIMIT)
    for (const item of rejected) {
      const drop = reviewDrops.get(item.key) ?? drops.find(entry => !entry.stored && brandKeyFromText(entry.alias) === item.key)
      const reason: CompetitorAutoAliasReason = item.rejection ?? drop?.reason ?? 'over-limit'
      candidates.push(candidateFromEvidence(item, 'rejected', reason, drop?.conflictsWith))
    }

    const storedNames = competitor.autoAliases.map(record => brandKeyFromText(record.name))
    const namesChanged = storedNames.length !== planned.length || planned.some((name, i) => brandKeyFromText(name) !== storedNames[i])
    return {
      domain: competitor.domain,
      autoAliases,
      added,
      removed,
      candidates,
      namesChanged,
      recordsChanged: namesChanged || !sameRecords(competitor.autoAliases, autoAliases),
    }
  })
}

export const competitorAutoAliasDetectionCompetitorSchema = z.object({
  domain: z.string(),
  /**
   * Present for a competitor an Advanced market pins without tracking it
   * project-wide: the active plan's markets (group keys) that pin it. Its
   * evidence counts only those markets' answers, and its names are stored for
   * them (never as a project competitor). Absent for a project competitor.
   */
  marketKeys: z.array(z.string()).optional(),
  /** Curated aliases (unchanged by detection); for a market competitor, its plan label and aliases. */
  aliases: z.array(z.string()),
  /** Auto names after this pass (or as the pass would leave them, on a dry run). */
  autoAliases: z.array(competitorAutoAliasSchema),
  blockedAliases: z.array(z.string()),
  added: z.array(z.string()),
  removed: z.array(z.object({
    name: z.string(),
    reason: competitorAutoAliasReasonSchema,
    conflictsWith: z.string().optional(),
  })),
  candidates: z.array(competitorAutoAliasCandidateSchema),
})
export type CompetitorAutoAliasDetectionCompetitor = z.infer<typeof competitorAutoAliasDetectionCompetitorSchema>

/**
 * `GET` (dry run) and `POST` (apply now) `/projects/{name}/competitor-auto-aliases`:
 * what the project's stored answers say about every tracked competitor's names.
 */
export const competitorAutoAliasDetectionDtoSchema = z.object({
  project: z.string(),
  /** True when this call stored the result (`POST`). */
  applied: z.boolean(),
  /** True when the stored auto names differ (or would differ, on a dry run) from before. */
  changed: z.boolean(),
  scan: z.object({
    /** Answer-visibility runs scanned (completed or partial, probes excluded), newest first. */
    runs: z.number().int().nonnegative(),
    snapshots: z.number().int().nonnegative(),
    /** Snapshots with stored answer text. */
    answers: z.number().int().nonnegative(),
    maxRuns: z.number().int().positive(),
    maxSnapshots: z.number().int().positive(),
    /**
     * True when provider citation structures (annotations, citations,
     * grounding supports, markers) were read; false on a host that cannot read
     * stored provider responses, where only pairings written in the answer
     * text count.
     */
    providerCitations: z.boolean(),
  }),
  thresholds: z.object({
    minDirectPairs: z.number().int().positive(),
    /** Distinct sweeps (runs started together count once). */
    minRuns: z.number().int().positive(),
    minNamingAnswers: z.number().int().positive(),
    minPrecision: fraction(z.number().min(0).max(1)),
    /** Precision over the competitor's smoothed citation rate in answers that do not name it. */
    minLift: z.number().positive(),
    /** Share of naming answers that must write the name capitalized as a name. */
    minNameCasedShare: fraction(z.number().min(0).max(1)),
    /** Shortest brand key applied without an operator's approval. */
    minKeyLength: z.number().int().positive(),
    /** This competitor's direct pairs must be at least this multiple of any other competitor's. */
    dominanceMultiple: z.number().positive(),
    /** A stored name is removed only below these lower bounds. */
    removeBelowPrecision: fraction(z.number().min(0).max(1)),
    removeBelowLift: z.number().nonnegative(),
    removeBelowNameCasedShare: fraction(z.number().min(0).max(1)),
  }),
  competitors: z.array(competitorAutoAliasDetectionCompetitorSchema),
})
export type CompetitorAutoAliasDetectionDto = z.infer<typeof competitorAutoAliasDetectionDtoSchema>

/** The thresholds a detection DTO reports, from the `AUTO_ALIAS_*` constants. */
export function competitorAutoAliasThresholds(): CompetitorAutoAliasDetectionDto['thresholds'] {
  return {
    minDirectPairs: AUTO_ALIAS_MIN_DIRECT_ANSWERS,
    minRuns: AUTO_ALIAS_MIN_RUNS,
    minNamingAnswers: AUTO_ALIAS_MIN_NAMING_ANSWERS,
    minPrecision: AUTO_ALIAS_MIN_PRECISION,
    minLift: AUTO_ALIAS_MIN_LIFT,
    minNameCasedShare: AUTO_ALIAS_MIN_NAME_CASED_SHARE,
    minKeyLength: AUTO_ALIAS_MIN_KEY_LENGTH,
    dominanceMultiple: AUTO_ALIAS_DOMINANCE_RATIO,
    removeBelowPrecision: AUTO_ALIAS_REMOVE_BELOW_PRECISION,
    removeBelowLift: AUTO_ALIAS_REMOVE_BELOW_LIFT,
    removeBelowNameCasedShare: AUTO_ALIAS_REMOVE_BELOW_NAME_CASED_SHARE,
  }
}

/** `POST /projects/{name}/competitors/{domain}/aliases/block` and `.../unblock`. */
export const competitorAliasBlockRequestSchema = z.object({
  aliases: z.array(z.string().trim().min(1)).min(1)
    .describe('Names to block from (or release back to) answer-derived auto-detection for this competitor. Compared by brand key, so case, spacing and punctuation variants are one name.'),
})
export type CompetitorAliasBlockRequest = z.infer<typeof competitorAliasBlockRequestSchema>

/** Most names one competitor may have blocked. */
export const COMPETITOR_BLOCKED_ALIAS_LIMIT = 50
