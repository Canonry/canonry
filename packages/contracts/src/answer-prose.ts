/**
 * THE ANSWER'S PROSE, FOR MENTION MATCHING.
 *
 * A mention is the brand named in the answer's prose; a citation is the domain
 * in the answer's sources. Providers also write their sources INTO the answer
 * text: OpenAI web search appends inline chips such as
 * `([harborview.com](https://harborview.com/floor-plans?utm_source=chatgpt.com))`,
 * Perplexity writes `[1]` markers, and some answers end with reference
 * definitions or bare URLs. Matching brand aliases or owned domains over that
 * markup reads every citation chip as a mention, i.e. computes one signal from
 * the other. This module removes the citation markup and keeps the prose.
 *
 * What is removed (each span becomes one space):
 * - a citation CHIP: one or more markdown links inside parentheses with only
 *   separators between them, whatever the labels say;
 * - a markdown link whose label is a URL, an address with a path, a lowercase
 *   host (`harborview.com`, how providers label a source), or a citation
 *   token (`1`, `[1]`, `source`, `link`);
 * - reference definitions (`[1]: https://...`), footnote definitions and
 *   markers (`[^1]`), and bare numeric markers (`[1]`, `[1, 2]`);
 * - bare `http(s)://` URLs, markdown images, and provider citation markers
 *   (OpenAI's private-use `cite` spans, dagger markers such as `【4:0†source】`).
 *
 * What is kept: every other markdown link keeps its label and loses its URL,
 * so `[Bayside Flats](https://...) is a strong pick` still names Bayside Flats,
 * and a brand whose name is its domain (`**[Harborview.ai](https://...)** is`)
 * is still named. A host written in prose outside any link
 * (`Tour at harborview.com`, `www.harborview.com`) is prose and stays, as do
 * `【...】` brackets used as punctuation and text that follows a URL with no
 * space (common in Chinese and Japanese answers).
 *
 * Every pattern is linear: each repeated group starts or ends on a delimiter
 * its neighbours cannot consume, and every free-text run is bounded. This runs
 * over every stored answer of every project.
 */

import tlds from 'tlds'

const TOP_LEVEL_DOMAINS: ReadonlySet<string> = new Set(tlds.map(tld => tld.toLowerCase()))

/** None of the markup below can be present without one of these. */
const MARKUP_HINT = /[[【\uE200]|https?:\/\/|cite\uE202?turn/i

/** A markdown link label: free text, or one nested `[...]` level (`[[1]](url)`). */
const LABEL = String.raw`(?:[^[\]\n]|\[[^[\]\n]{0,300}\]){0,300}`
/** A link target: no whitespace, parentheses only as balanced pairs, optional title. */
const TARGET = String.raw`(?:[^()\s]|\([^()\s]{0,500}\))*(?:[ \t]{1,10}"[^"\n]{0,300}")?`
const INLINE_LINK = String.raw`\[${LABEL}\]\(${TARGET}\)`
const REFERENCE_LINK = String.raw`\[${LABEL}\]\[[^[\]\n]{0,100}\]`
const ANY_LINK = `(?:${INLINE_LINK}|${REFERENCE_LINK})`
const CHIP_SEPARATOR = String.raw`(?:\s{0,10}[,;&]\s{0,10}|\s{1,10}and\s{1,10}|\s{0,10})`

/** OpenAI's private-use citation span: `\uE200cite\uE202turn0search3\uE202turn1news0\uE201`. */
const PRIVATE_USE_CITATION = /\uE200(?:file)?cite\uE202[^\uE200\uE201\n]{0,500}\uE201/g
/** The same citation once its private-use delimiters were dropped: `citeturn0search3turn1news0`. */
const BARE_CITE_TOKEN = /(?:file)?cite(?:turn\d{1,4}[a-z]{1,20}\d{1,4}){1,50}/gi
/**
 * Legacy OpenAI markers such as `【4:0†source】`. The dagger is required:
 * `【...】` is ordinary Chinese and Japanese punctuation around names.
 */
const LENTICULAR_CITATION = /【[^【】\n†]{0,100}†[^【】\n]{0,200}】/g
const IMAGE = new RegExp(String.raw`!\[${LABEL}\]\(${TARGET}\)`, 'g')
/** Parentheses holding nothing but links and separators. */
const CITATION_CHIP = new RegExp(String.raw`\(\s{0,10}${ANY_LINK}(?:${CHIP_SEPARATOR}${ANY_LINK}){0,50}\s{0,10}\)`, 'g')
const INLINE_LINK_CAPTURE = new RegExp(String.raw`\[(${LABEL})\]\(${TARGET}\)`, 'g')
const REFERENCE_LINK_CAPTURE = new RegExp(String.raw`\[(${LABEL})\]\[[^[\]\n]{0,100}\]`, 'g')
/** `[^1]: note`: a footnote definition is the source it points at. */
const FOOTNOTE_DEFINITION = /^[ \t]{0,3}\[\^[^[\]\n]{1,100}\]:[^\n]*/gm
/** `[1]: https://...` or `[1]: harborview.com/...` */
const REFERENCE_DEFINITION = /^[ \t]{0,3}\[[^[\]\n]{1,100}\]:[ \t]*<?(?:https?:\/\/|www\.|[\p{L}\p{N}-]{1,63}\.[\p{L}\p{N}.-]{1,253}(?=[/?#>\s]|$))[^\n]*/gimu
const FOOTNOTE_MARKER = /\[\^[^[\]\s]{1,100}\]/g
/** `[1]`, `[1, 2]`, `[1-3]`, `[1†source]` */
const NUMERIC_MARKER = /\[\d{1,3}(?:[ \t]{0,3}[,–-][ \t]{0,3}\d{1,3}){0,20}(?:†[^[\]\n]{0,100})?\]/g
/**
 * A URL body is URL-legal ASCII only (`\w` is ASCII without the `u` flag): in
 * Chinese, Japanese, or Thai text the prose that follows a URL has no space
 * before it (`https://example.jp/で予約`), and neither does text after an
 * unspaced em dash.
 */
const URL_CHAR = String.raw`[\w\-.~:/?#@!$&*+,;=%]`
const BARE_URL = new RegExp(String.raw`\bhttps?:\/\/(?:${URL_CHAR}|\(${URL_CHAR}{0,500}\))+`, 'gi')

const CITATION_WORD = /^(?:\d{1,3}|sources?|links?|refs?|citations?)$/i
const LABEL_DECORATION_START = /^[\s*_`"'[\]^()]+/
const LABEL_DECORATION_END = /[\s*_`"'[\]()]+$/
const HOST_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u

/**
 * A label that writes out a source's address: a URL, a host followed by a
 * path, or a lowercase host (`harborview.com`, how providers label a source).
 * A bare host in brand case (`Harborview.ai`, `Booking.com`) is a name that
 * happens to be a domain, used as the subject of a sentence, so it is prose.
 */
function isSourceAddress(value: string): boolean {
  if (/\s/.test(value)) return false
  if (/^(?:https?:\/\/|www\.)/i.test(value)) return true
  const pathStart = value.search(/[/?#:]/)
  const host = (pathStart === -1 ? value : value.slice(0, pathStart)).replace(/\.$/, '')
  const labels = host.split('.')
  if (labels.length < 2) return false
  if (!labels.every(label => HOST_LABEL.test(label))) return false
  if (!TOP_LEVEL_DOMAINS.has(labels[labels.length - 1]!.toLowerCase())) return false
  return pathStart !== -1 || host === host.toLowerCase()
}

/**
 * True when a markdown link label points at a source rather than naming
 * something: a URL, an address with a path, a lowercase host, or a citation
 * token. `[Bayside Flats](https://...)` names Bayside Flats; `[bayside.example](https://...)`
 * cites a source. Competitor auto-alias detection reads a named link as the
 * answer pairing that name with the link's site.
 */
export function isCitationLabel(label: string): boolean {
  const core = label.replace(LABEL_DECORATION_START, '').replace(LABEL_DECORATION_END, '')
  if (core === '') return true
  if (CITATION_WORD.test(core)) return true
  return isSourceAddress(core)
}

function keepProseLabel(_match: string, label: string): string {
  return isCitationLabel(label) ? ' ' : label
}

/**
 * The answer text with citation markup removed, for mention matching only.
 * Idempotent, and returns the input unchanged when it holds no markup.
 */
export function answerProseForMentions(text: string): string
export function answerProseForMentions(text: string | null | undefined): string | null
export function answerProseForMentions(text: string | null | undefined): string | null {
  if (text == null) return null
  if (!MARKUP_HINT.test(text)) return text
  return text
    .replace(PRIVATE_USE_CITATION, ' ')
    .replace(BARE_CITE_TOKEN, ' ')
    .replace(LENTICULAR_CITATION, ' ')
    .replace(IMAGE, ' ')
    .replace(CITATION_CHIP, ' ')
    .replace(INLINE_LINK_CAPTURE, keepProseLabel)
    .replace(REFERENCE_LINK_CAPTURE, keepProseLabel)
    .replace(FOOTNOTE_DEFINITION, ' ')
    .replace(REFERENCE_DEFINITION, ' ')
    .replace(FOOTNOTE_MARKER, ' ')
    .replace(NUMERIC_MARKER, ' ')
    .replace(BARE_URL, ' ')
}

/**
 * The answer text with only its citation chips removed; every other link keeps
 * its markdown. For a reader that keys on prose links' `[Name](url)` syntax
 * (the recommended-competitor extractor), which `answerProseForMentions` has
 * already unwrapped. A name that appears only in a chip is a citation there too.
 */
export function stripCitationChips(text: string): string {
  if (!text.includes('](') && !text.includes('][')) return text
  return text.replace(CITATION_CHIP, ' ')
}
