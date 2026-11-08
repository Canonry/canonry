/** Conservative hotel policy preflight, including the complete linked HTML and links. */
import { decodeHTML } from 'entities'
import { hostOf } from '@canonry/canonry-contracts'
import { createGuardedFetch, type GuardedFetch } from './guarded-fetch.js'

/**
 * "Offer" and "deal" are also ordinary verbs ("this guide deals with leaks",
 * "does the contractor offer inspections", "what the manufacturer offers",
 * "the company offers free inspections"). These constructions read as verbs and
 * never as a promotion, so they are set aside before the word check. Every
 * promotional phrase is still refused, wherever it appears.
 */
const WORD = String.raw`[\p{L}\p{N}&.'’-]+`
const VERB_USES = [
  /\bdeals?\s+with\b/gu,
  new RegExp(
    String.raw`\b(?:does|do|did|will|would|can|could|may|might|should|must|to)\s+(?:not\s+)?(?:${WORD}\s+){0,4}?offer\b`,
    'gu',
  ),
  new RegExp(String.raw`\bwhat\s+(?:${WORD}\s+){0,3}?offers?\b`, 'gu'),
  /\boffers?(?=\s+(?:a|an|the|free|both|several|written|financing|warrant(?:y|ies)|inspections?|services?|repairs?|coverage|options?|support)\b)/gu,
]
function withoutVerbUses(text: string): string {
  return VERB_USES.reduce((value, verb) => value.replace(verb, ' '), text)
}

export function hotelEditorialText(value: string): boolean {
  const text = decodeHTML(value).normalize('NFKC').toLowerCase()
  return (
    text.trim().length > 0 &&
    !/\b(?:offers?|deals?|promotions?|discounts?|coupons?|promo\s*codes?|special\s+rates?|book\s+now|save\s+\d+)\b|\d+\s*%\s*off/iu.test(
      withoutVerbUses(text),
    )
  )
}

/**
 * Promotions refused anywhere, including an article's own sentences: the strong
 * signals above, and offer or deal used as a promotion ("special offers", "travel
 * deals", "explore our deals", "offer ends", "deal of the week").
 */
const PROMOTION = new RegExp(
  [
    String.raw`\b(?:promotions?|discounts?|coupons?|promo\s*codes?|special\s+rates?|book\s+now|save\s+\d+)\b`,
    String.raw`\d+\s*%\s*off`,
    String.raw`\b(?:special|exclusive|limited[-\s]+time|seasonal|holiday|weekend|package|hot|last[-\s]+minute|early[-\s]+bird|flash|daily|weekly|monthly|travel|room|hotel|stay|spa|dining|best|great|top|our|these|latest|current|view|see|explore|browse|all)\s+(?:offers?|deals?)\b`,
    String.raw`\b(?:offers?|deals?)\s+(?:end(?:s|ing)?|expire[sd]?|expiring|code)\b`,
    String.raw`\b(?:deal|offer)\s+of\s+the\s+(?:day|week|month)\b`,
  ].join('|'),
  'u',
)
function promotionFree(value: string): boolean {
  return !PROMOTION.test(decodeHTML(value).normalize('NFKC').toLowerCase())
}

/**
 * An article's own sentences (paragraph and list-item text) are left out of the
 * plain word check, so "offer" and "deal" can be used in them as ordinary words.
 * Links inside them, every tag and attribute, headings, menus, buttons and
 * structured data keep that check.
 */
const TAG = String.raw`<(?:[^"'<>]|"[^"]*"|'[^']*')*>`
const SENTENCES =
  /(<(p|li)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/giu
const SENTENCE_PARTS = new RegExp(String.raw`(<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?<\/a\s*>|${TAG})|[^<]+`, 'giu')
function withoutSentenceText(html: string): string {
  return html.replace(
    SENTENCES,
    (_whole, open: string, _tag: string, inner: string, close: string) =>
      open +
      inner.replace(SENTENCE_PARTS, (_part, markup: string | undefined) => markup ?? ' ') +
      close,
  )
}

const JSON_STRING = /"(?:\\.|[^"\\])*"/gu

/**
 * Percent-decode each run of escapes. A run that is not valid UTF-8 becomes a
 * space rather than throwing: one malformed escape on a page must not refuse
 * it outright, and a space still separates any word hidden behind it.
 */
function decodePercentRuns(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/giu, (part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return ' '
    }
  })
}
const SCHEMA_TYPE =
  /^(?:https?:\/\/schema\.org\/)?(?:Offer|AggregateOffer|OfferCatalog)$/u
const SCHEMA_CONTEXT = /^https?:\/\/schema\.org\/?$/u

/** Keep every source value, including duplicate members; only schema identifiers are masked. */
function editorialJsonLd(source: string): string | null {
  try {
    const parsed: unknown = JSON.parse(source)
    if (parsed === null || typeof parsed !== 'object') return null
    const roots: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    if (
      roots.length === 0 ||
      roots.some(
        (value) =>
          value === null || typeof value !== 'object' || Array.isArray(value),
      )
    )
      return null
    const pending = roots.map((value) => ({ value, depth: 0 }))
    let visited = 0
    while (pending.length > 0) {
      const { value, depth } = pending.pop()!
      if (depth > 32 || ++visited > 10_000) return null
      if (value === null || typeof value !== 'object') continue
      if (Array.isArray(value)) {
        pending.push(
          ...value.map((item: unknown) => ({ value: item, depth: depth + 1 })),
        )
        continue
      }
      const row = value as Record<string, unknown>
      if (depth === 0 || Object.hasOwn(row, '@context')) {
        const context = row['@context']
        if (typeof context !== 'string' || !SCHEMA_CONTEXT.test(context))
          return null
      }
      pending.push(
        ...Object.values(row).map((item) => ({
          value: item,
          depth: depth + 1,
        })),
      )
    }
    // Decode string escapes without JSON.stringify(parsed), which would erase
    // duplicate members and could hide an earlier promotional value.
    const canonical = source.replace(JSON_STRING, (token) =>
      JSON.stringify(
        decodePercentRuns(decodeHTML(String(JSON.parse(token))).normalize('NFKC'))
          .replace(/\s+/gu, ' '),
      ),
    )
    // These member names / enum values indicate real promotional structured data,
    // even when camel-casing means the prose keyword matcher would miss them.
    for (const match of canonical.matchAll(
      /(?:\{|,)\s*("(?:\\.|[^"\\])*")\s*:/gu,
    )) {
      const key = String(JSON.parse(match[1]!))
        .replace(/[^a-z]/giu, '')
        .toLowerCase()
      if (
        /discount|coupon|promo|specialrate|saleprice|strikethroughprice/u.test(
          key,
        )
      )
        return null
    }
    for (const match of canonical.matchAll(JSON_STRING)) {
      if (
        /^(?:https?:\/\/schema\.org\/)?(?:SalePrice|StrikethroughPrice)$/u.test(
          String(JSON.parse(match[0])),
        )
      )
        return null
    }
    return canonical
      .replace(
        /([,{]\s*"@type"\s*:\s*)("(?:\\.|[^"\\])*"|\[\s*\]|\[\s*"(?:\\.|[^"\\])*"(?:\s*,\s*"(?:\\.|[^"\\])*")*\s*\])/gu,
        (_whole, prefix: string, raw: string) => {
          const types: unknown = JSON.parse(raw)
          const mask = (type: unknown): unknown =>
            typeof type === 'string' && SCHEMA_TYPE.test(type)
              ? 'SchemaType'
              : type
          return (
            prefix +
            JSON.stringify(Array.isArray(types) ? types.map(mask) : mask(types))
          )
        },
      )
      .replace(/([,{]\s*)"offers"(\s*:)/gu, '$1"schemaOffers"$2')
  } catch {
    return null
  }
}

function editorialHtml(html: string): boolean {
  let valid = true
  const text = html.replace(
    /<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/giu,
    (whole: string, attributes: string, body: string) => {
      if (
        !/(?:^|\s)type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json(?=\s|$))/iu.test(
          attributes,
        )
      )
        return whole
      const normalized = editorialJsonLd(body)
      if (normalized === null) {
        valid = false
        return whole
      }
      return `<script${attributes}>${normalized}</script>`
    },
  )
  const markup = withoutSentenceText(text)
  return (
    valid &&
    hotelEditorialText(markup) &&
    hotelEditorialText(decodePercentRuns(markup)) &&
    promotionFree(text) &&
    promotionFree(decodePercentRuns(text))
  )
}
export async function hotelEditorialDestination(
  domain: string,
  summary: string,
  articleUrl: string,
  fetchImpl: GuardedFetch = createGuardedFetch(),
): Promise<boolean> {
  try {
    const host = hostOf(domain)
    const target = new URL(articleUrl)
    if (
      !host ||
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.port ||
      target.hash ||
      target.search ||
      ![host, `www.${host}`].includes(target.hostname) ||
      !hotelEditorialText(summary + ' ' + decodePercentRuns(target.pathname))
    )
      return false
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(20_000),
    })
    if (
      response.status !== 200 ||
      !response.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('text/html') ||
      new URL(response.url || target.href).origin !== target.origin ||
      !response.body
    )
      return false
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 512 * 1024) {
        await reader.cancel()
        return false
      }
      chunks.push(part.value)
    }
    const html = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    )
    // Scan markup as well as visible copy: a linked /offers page is disallowed
    // even when its anchor says something innocuous. Encoded paths are decoded.
    return editorialHtml(html)
  } catch {
    return false
  }
}
