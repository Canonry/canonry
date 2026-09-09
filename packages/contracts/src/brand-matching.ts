/**
 * EXACT BRAND IDENTITY MATCHING.
 *
 * An approved alias matches as one or more COMPLETE adjacent words, so
 * presentation variants (`Demand IQ`, `Demand-IQ`, `DemandIQ`) all match while
 * spelling guesses never do: `acme` does not match `acmeology`, and `prime`
 * does not match `price`. Similarity is not identity, so nothing here uses
 * edit distance or substrings.
 *
 * A FIXED LOCALE, deliberately. `undefined` resolves to whatever the host is
 * set to, which makes a KPI depend on the machine that computed it: the same
 * answer could segment one way on a laptop and another inside a container.
 * Nothing about this matching repays that risk.
 */
const WORD_SEGMENTER = new Intl.Segmenter('en', { granularity: 'word' })

/** Everything that is not a letter or a digit, i.e. whatever separates words. */
const NON_WORD = /[^\p{L}\p{N}]+/gu
const WORD_RUNS = /[\p{L}\p{N}]+/gu

/**
 * The alphabets that write an accent OVER a base letter which stands on its own.
 * Folding is decided by this base, never by the mark, because "is this mark an
 * accent" has no script-independent answer: `Script=Inherited` contains the
 * Japanese dakuten and the Arabic hamza, and stripping those turns `が` into
 * `か` and `أ` into `ا`, which are different letters, not styled ones.
 */
const ACCENT_BEARING_SCRIPT = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u

/**
 * Cheap reject. Accents live above U+007F, so pure ASCII can skip the fold
 * entirely, and this runs over every answer text of every project.
 */
const NON_ASCII = /\P{ASCII}/u

/**
 * Drop accents from Latin, Greek and Cyrillic letters, leaving every other
 * script exactly as written.
 *
 * Per character, so the decision is made against the letter UNDER the mark. A
 * blanket "delete all combining marks" cannot work: the same Unicode category
 * holds the acute on `É`, the dakuten that separates `が` from `か`, and the
 * hamza that separates `أ` from `ا`. Only the first is decoration.
 *
 * Recomposing is what keeps a key's LENGTH stable, which matters because the
 * alias floors are counted in characters: NFKD alone explodes Hangul syllables
 * into jamo and turns a 2-character brand into a 6-character one, sneaking it
 * past a floor meant to reject it.
 */
function foldAccents(value: string): string {
  if (!NON_ASCII.test(value)) return value
  let folded = ''
  for (const character of value) {
    // An ASCII character can carry no accent, and answer prose is overwhelmingly
    // ASCII. Without this, one curly quote anywhere in the text sends every
    // other character through `normalize`, and this runs once per competitor
    // per answer.
    if (character.charCodeAt(0) < 0x80) {
      folded += character
      continue
    }
    const decomposed = character.normalize('NFD')
    const base = decomposed[0]!
    folded += decomposed.length > 1 && ACCENT_BEARING_SCRIPT.test(base) ? base : character
  }
  return folded
}

/**
 * Fold presentation variants without changing spelling.
 *
 * ACCENTS ARE A PRESENTATION VARIANT, in the same family as `Demand-IQ` vs
 * `DemandIQ`. A brand written `Totême` or `Éterne` on its own site is written
 * `Toteme` and `Eterne` by half the prose that mentions it, and the alias
 * derived from its domain has no accents at all, so without folding an accented
 * brand is invisible to every mention metric. Measured on a real run: a
 * competitor named in two answers scored zero, and another was undercounted.
 *
 * NFKC first so a decomposed input is composed before the fold sees it, and the
 * fold itself recomposes nothing it did not decompose. The cost, accepted: a
 * Latin brand distinguished from an ordinary word ONLY by its accents now
 * matches that word. Complete-adjacent-word matching is untouched, so this
 * widens what counts as the same SPELLING, never what counts as a similar one.
 */
function normalizeForMatch(value: string): string {
  return foldAccents(value.normalize('NFKC')).toLocaleLowerCase('en')
}

/** The word tokens of an already-normalized string. */
function wordsOfNormalized(normalized: string): string[] {
  const words: string[] = []
  for (const segment of WORD_SEGMENTER.segment(normalized)) {
    if (!segment.isWordLike) continue
    for (const word of segment.segment.match(WORD_RUNS) ?? []) words.push(word)
  }
  return words
}

/**
 * Unicode-aware word tokens for brand identity matching. Compatibility
 * normalization folds presentation variants without changing spelling.
 */
export function brandWords(value: string): string[] {
  return wordsOfNormalized(normalizeForMatch(value))
}

/**
 * Compact key used to compare an approved brand name across punctuation,
 * spacing, and casing variants.
 */
export function brandKeyFromText(value: string): string {
  return brandWords(value).join('')
}

/** Approved aliases compiled once, so one list can be reused across many texts. */
export interface BrandAliasMatcher {
  readonly keys: ReadonlySet<string>
  /** Nothing longer than this can match, so the inner scan stops there. */
  readonly longest: number
}

/**
 * One answer's normalized representation, reusable across brand matchers.
 *
 * Competitor reporting checks the same answer against several independently
 * compiled identities. Keep the normalization and word walk with the answer,
 * while each matcher retains its own exact alias set.
 */
export interface PreparedBrandMatchText {
  readonly normalized: string
  readonly stripped: string
}

const wordsByPreparedText = new WeakMap<PreparedBrandMatchText, string[]>()

/** Normalize an answer once before checking it against several matchers. */
export function prepareBrandMatchText(text: string | null | undefined): PreparedBrandMatchText | null {
  if (!text) return null
  const normalized = normalizeForMatch(text)
  return { normalized, stripped: normalized.replace(NON_WORD, '') }
}

function wordsOfPreparedText(prepared: PreparedBrandMatchText): string[] {
  const cached = wordsByPreparedText.get(prepared)
  if (cached) return cached
  const words = wordsOfNormalized(prepared.normalized)
  wordsByPreparedText.set(prepared, words)
  return words
}

/**
 * Compile approved aliases into a reusable matcher.
 *
 * Exposed rather than hidden because the shape of the work is one alias list
 * against thousands of texts: a caller classifying a whole property's answers
 * should build this once, not once per answer.
 */
export function compileBrandAliases(aliases: readonly string[]): BrandAliasMatcher {
  const keys = new Set<string>()
  let longest = 0
  for (const alias of aliases) {
    if (!alias) continue
    const key = brandKeyFromText(alias)
    if (!key) continue
    keys.add(key)
    if (key.length > longest) longest = key.length
  }
  return { keys, longest }
}

/**
 * Does any compiled alias appear in the text as complete adjacent words?
 *
 * ONE segmentation for the whole alias set. Asking each alias separately
 * re-segmented the entire text every time, so cost grew with the alias count:
 * measured on a real corpus, the marginal cost of an eighth alias was 604ms
 * against 580ms for a single full segmentation. Since the point of approving
 * aliases is that clients accumulate them, the cost grew exactly where the
 * design says it must not.
 *
 * THE CHEAP REJECT comes first. `wordCharsOnly` is every letter and digit in
 * order with everything else dropped. A match needs adjacent words whose
 * concatenation equals an alias key, and adjacent words are separated in the
 * source by non-word characters only, so a matching alias MUST appear there as
 * a contiguous substring. The converse does not hold (it also "finds" `acme`
 * inside `acmeology`), which is precisely why it only ever rejects. It pays
 * because most answers mention nothing: one regex pass against a full Unicode
 * walk.
 */
export function matcherMatchesText(
  matcher: BrandAliasMatcher,
  text: string | PreparedBrandMatchText | null | undefined,
): boolean {
  if (!text || matcher.keys.size === 0) return false
  const prepared = typeof text === 'string' ? prepareBrandMatchText(text) : text
  if (!prepared) return false

  let possible = false
  for (const key of matcher.keys) {
    if (prepared.stripped.includes(key)) {
      possible = true
      break
    }
  }
  if (!possible) return false

  const words = wordsOfPreparedText(prepared)
  for (let start = 0; start < words.length; start++) {
    let candidate = ''
    for (let end = start; end < words.length; end++) {
      candidate += words[end]
      if (matcher.keys.has(candidate)) return true
      if (candidate.length >= matcher.longest) break
    }
  }
  return false
}

/**
 * WHICH aliases matched, from a single pass.
 *
 * Same walk as {@link matcherMatchesText}, collecting instead of returning at
 * the first hit. The caller that needs to report which identity it saw would
 * otherwise ask once per term and pay a full segmentation for each.
 */
export function matchedAliasKeys(
  matcher: BrandAliasMatcher,
  text: string | PreparedBrandMatchText | null | undefined,
): Set<string> {
  const found = new Set<string>()
  if (!text || matcher.keys.size === 0) return found
  const prepared = typeof text === 'string' ? prepareBrandMatchText(text) : text
  if (!prepared) return found
  const reachable = [...matcher.keys].filter(key => prepared.stripped.includes(key))
  if (reachable.length === 0) return found

  const words = wordsOfPreparedText(prepared)
  for (let start = 0; start < words.length; start++) {
    let candidate = ''
    for (let end = start; end < words.length; end++) {
      candidate += words[end]
      if (matcher.keys.has(candidate)) found.add(candidate)
      if (candidate.length >= matcher.longest) break
    }
    if (found.size === matcher.keys.size) break
  }
  return found
}

/**
 * Match an approved brand alias as one or more complete adjacent words.
 *
 * This tolerates presentation-only variants (`Demand IQ`, `Demand-IQ`,
 * `DemandIQ`) but never edit-distance or substring guesses (`prime` does not
 * match `price`, and `acme` does not match `acmeology`).
 */
export function textContainsBrandAlias(
  text: string | null | undefined,
  alias: string | null | undefined,
): boolean {
  if (!alias) return false
  return matcherMatchesText(compileBrandAliases([alias]), text)
}

/** Match any operator-approved or domain-derived alias in prose. */
export function textContainsAnyBrandAlias(
  text: string | null | undefined,
  aliases: readonly string[],
): boolean {
  return matcherMatchesText(compileBrandAliases(aliases), text)
}
