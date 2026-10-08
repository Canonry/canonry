import { stripCitationChips } from './answer-prose.js'
import { brandKeyFromText } from './brand-matching.js'

/**
 * BUSINESS NAMES AS AN ANSWER LAYS THEM OUT.
 *
 * Answer engines present recommendations in a few fixed layouts: a list item
 * that leads with the name (`- **TuneSpoke**: mobile tune-ups`), a bold name
 * in prose, a heading, or a named link (`[TuneSpoke](https://...)`). This reads
 * those layouts and returns the names as written. It knows nothing about which
 * names are businesses the project tracks: the recommended-competitor
 * extractor filters the laid-out names against known identities
 * (`extractLaidOutBusinessNames`), and competitor auto-alias detection pairs
 * the candidates with the sources the answer cites
 * (`extractBusinessNameCandidates`).
 *
 * A name that appears only inside a citation chip (`([Rival](https://...))`)
 * is a citation, not a name the answer lays out, so chips are removed first.
 */

/**
 * Name characters, Unicode-aware: letters of any script with their combining
 * marks (`TuneSpóke`, `Søren`, a decomposed accent), digits, `_`, spaces, and
 * the punctuation names carry (`.&',/()-`, and the curly apostrophes of
 * `Joe’s` and `Joe‘s`).
 */
const NAME_CHARACTER = String.raw`[\p{L}\p{M}\p{N}_\s.&'\u2018\u2019,/()-]`
/** The apostrophes a name may carry: straight, and the curly right and left single quotes. */
const APOSTROPHE = String.raw`['\u2018\u2019]`
/**
 * A letter or digit a name may open with: a capital (titlecase included), a
 * digit, or a letter of a script with no case (CJK, Thai, Arabic, ...), which
 * cannot be capitalized. Any combining marks written on it follow it (a
 * decomposed `É` is `E` and U+0301).
 */
const NAME_OPENING = String.raw`[\p{Lu}\p{Lt}\p{Lo}\p{N}]\p{M}*`
/**
 * How a name opens: `NAME_OPENING` and a letter or digit, or a capital, an
 * apostrophe and a capital (`O'Quillan's`, `D'Avrel`).
 */
const NAME_START = String.raw`(?:${NAME_OPENING}[\p{L}\p{N}]|\p{Lu}\p{M}*${APOSTROPHE}(?=\p{Lu}))`
/** A name body: opens with `NAME_START`, then up to 50 name characters. */
const NAME_BODY = String.raw`${NAME_START}${NAME_CHARACTER}{1,50}`
/**
 * The detection body also opens with dotted initials (`A.J. Spokes`) or a
 * number followed by a capitalized word (`1 Spoke Lane`). The extractor that
 * writes stored `recommended_competitors` keeps `NAME_BODY`, so those two
 * openings never reach its stored values.
 */
const DETECTION_NAME_BODY = String.raw`(?:${NAME_START}|\p{Lu}\p{M}*\.(?=\p{Lu})|\p{N}{1,4}\s(?=\p{Lu}))${NAME_CHARACTER}{1,50}`

function layoutPatterns(body: string): readonly RegExp[] {
  return [
    // List lead: `- **Name** - ...`, `1. Name: ...` (dash, colon, en or em dash).
    new RegExp(String.raw`^\s*(?:[-*]|\d+\.)\s+(?:\*\*)?(${body}?)(?:\*\*)?\s*[:\u2014\u2013-]`, 'gmu'),
    // Bold name anywhere.
    new RegExp(String.raw`\*\*(${body})\*\*`, 'gu'),
    // Heading: `### 2. Name`.
    new RegExp(String.raw`^#{1,4}\s+(?:\d+\.\s+)?(?:\*\*)?(${body}?)(?:\*\*)?$`, 'gmu'),
    // Named link: `[Name](https://...)`.
    new RegExp(String.raw`\[(${body})\]\(https?:\/\/[^\s)]+\)`, 'gu'),
  ]
}

const LAYOUT_PATTERNS = layoutPatterns(NAME_BODY)
const DETECTION_PATTERNS = layoutPatterns(DETECTION_NAME_BODY)

/**
 * Layout words that lead list items and headings but name nothing: section
 * headings ("Overview", "Key Features") and verdict lines ("Bottom Line").
 * Compared by brand key.
 */
const GENERIC_CANDIDATE_KEYS: ReadonlySet<string> = new Set([
  'additional',
  'best',
  'benefits',
  'bottomline',
  'comparison',
  'conclusion',
  'directorylisting',
  'example',
  'expertise',
  'features',
  'finalthoughts',
  'howitworks',
  'important',
  'keybenefits',
  'keyfeatures',
  'major',
  'note',
  'notable',
  'option',
  'other',
  'overview',
  'pricing',
  'pros',
  'reviews',
  'step',
  'summary',
  'top',
  'verdict',
  'whattolookfor',
  'whyitmatters',
  'whyitstandsout',
  'whywechoseit',
])

/** A candidate longer than this many words is a sentence, not a name. */
export const MAX_BUSINESS_NAME_WORDS = 6

/**
 * A laid-out name with surrounding quotes and closing punctuation trimmed and
 * spaces collapsed, nothing else: `Quillan's` and `Prospekt (prospekt.example)`
 * stay as written, so an identity match sees the whole name.
 */
function trimLaidOutName(candidate: string): string {
  return candidate
    .replace(/^[\s"'`]+|[\s"'`.,:;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A candidate as a name: markdown emphasis removed, a trailing parenthetical
 * (`Acme Bikes (Springfield, IL)`) and a leading list marker (`3. `) dropped,
 * quotes and closing punctuation trimmed, spaces collapsed. A possessive stays (`Joe's`, `Quillan's`): it is
 * how such a brand is written, and dropping it would offer `Quillan` for
 * `quillans.example`.
 */
export function cleanBusinessNameCandidate(candidate: string): string {
  let name = candidate.replace(/[*_]+/g, ' ').trimEnd()
  // Repeated: `Name (City) (2024)` sheds both.
  for (let i = 0; i < 3; i++) {
    const next = withoutTrailingParenthetical(name)
    if (next === name) break
    name = next
  }
  return name
    .replace(/^[\s"'`]+|[\s"'`.,:;!?/&-]+$/g, '')
    // A list marker the layout carried along (`3. Acme Bikes`).
    .replace(/^(?:\d{1,3}[.)]|[-*\u2022])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `name` without a final `(...)`, closed at the very end or left open by a cut-off layout. */
function withoutTrailingParenthetical(name: string): string {
  const open = name.lastIndexOf('(')
  if (open === -1) return name
  const close = name.indexOf(')', open)
  if (close !== -1 && close !== name.length - 1) return name
  return name.slice(0, open).trimEnd()
}

function scanLayouts(
  text: string | null | undefined,
  patterns: readonly RegExp[],
  clean: (candidate: string) => string,
): string[] {
  if (!text) return []
  const scanText = stripCitationChips(text)
  const seen = new Set<string>()
  const result: string[] = []
  for (const pattern of patterns) {
    for (const match of scanText.matchAll(pattern)) {
      const candidate = clean(match[1]!)
      if (!candidate || seen.has(candidate)) continue
      const key = brandKeyFromText(candidate)
      if (!key || GENERIC_CANDIDATE_KEYS.has(key)) continue
      if (candidate.split(/\s+/).length > MAX_BUSINESS_NAME_WORDS) continue
      seen.add(candidate)
      result.push(candidate)
    }
  }
  return result
}

/**
 * Every name the answer lays out, in pattern order then text order, only
 * trimmed of quotes and closing punctuation (`Quillan's` and `Prospekt
 * (prospekt.example)` stay whole). Drops layout words
 * (`GENERIC_CANDIDATE_KEYS`), names longer than `MAX_BUSINESS_NAME_WORDS`
 * words, and repeats of the same spelling. The recommended-competitor
 * extractor reads these, so the stored `recommended_competitors` values keep
 * their form.
 */
export function extractLaidOutBusinessNames(text: string | null | undefined): string[] {
  return scanLayouts(text, LAYOUT_PATTERNS, trimLaidOutName)
}

/**
 * Business-name candidates for answer-derived competitor alias detection:
 * the layouts `extractLaidOutBusinessNames` reads, plus names that open with
 * dotted initials or a number followed by a capitalized word, each cleaned by
 * `cleanBusinessNameCandidate`. Different spellings of one name ("Tune
 * Spoke", "TuneSpoke") are all returned: callers that need one per brand key
 * dedupe after their own filtering, because word breaks matter to whole-word
 * matching.
 */
export function extractBusinessNameCandidates(text: string | null | undefined): string[] {
  return scanLayouts(text, DETECTION_PATTERNS, cleanBusinessNameCandidate)
}
