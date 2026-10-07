import { createHash } from 'node:crypto'
import { canonicalSentimentJson, type SentimentClassifierInput, type SentimentEvaluationDefinition } from '@ainyc/canonry-contracts'
import type { SentimentSourceAssessment } from './sentiment-source.js'

export function sentimentHash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalSentimentJson(value)).digest('hex')
}
type SentenceSpan = Omit<SentimentClassifierInput['sentences'][number], 'id'>
/** A period after these never ends a sentence: titles, street, measure and Latin abbreviations. */
const SPAN_ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'rev', 'sr', 'jr', 'st', 'mt', 'ft', 'sq', 'vs', 'cf', 'al'])
/** These continue the sentence only before a number: "No. 1", "approx. 30", "Sept. 2025". */
const NUMERIC_ABBREVIATIONS = new Set(['no', 'approx', 'est', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'])
/** True when the period ending `previous` is an abbreviation or list marker, not a sentence end. Newlines always split. */
function continuesSentence(text: string, previous: SentenceSpan, next: SentenceSpan): boolean {
  if (!previous.text.endsWith('.') || text.slice(previous.end, next.start).includes('\n')) return false
  const token = /\S+$/u.exec(previous.text)?.[0] ?? ''
  const word = token.replace(/^[(["'\u201C\u2018*_]+/u, '').slice(0, -1).toLowerCase()
  return SPAN_ABBREVIATIONS.has(word)
    || (NUMERIC_ABBREVIATIONS.has(word) && /^\d/u.test(next.text))
    // Initials and dotted abbreviations: "J.", "e.g.", "i.e.", "U.S.".
    || /^(?:[a-z]\.)*[a-z]$/u.test(word)
    // A span that is only a list marker such as "1." or "iv." belongs to the item it numbers.
    || (token === previous.text && /^(?:\d{1,3}|(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3}))$/u.test(word))
    // A lowercase continuation ("Acme Inc. offers", "etc. and") never starts a new sentence.
    || /^\p{Ll}/u.test(next.text)
}
/** Stable spans preserve every source byte; sentence selection never invents quotations. */
export function sentimentSentenceSpans(text: string): SentimentClassifierInput['sentences'] {
  const spans: SentenceSpan[] = []
  const expression = /[\s\S]+?(?:[.!?](?=\s|$)|\n+|$)/gu
  for (const match of text.matchAll(expression)) {
    const start = match.index + match[0].search(/\S/u)
    const end = match.index + match[0].trimEnd().length
    if (start < match.index || end <= start) continue
    const previous = spans.at(-1)
    const span = { text: text.slice(start, end), start, end }
    if (previous && continuesSentence(text, previous, span)) spans[spans.length - 1] = { text: text.slice(previous.start, end), start: previous.start, end }
    else spans.push(span)
  }
  return spans.map((span, index) => ({ id: `s${index + 1}`, ...span }))
}
/** Frozen comparison identity without source-text hashing or sentence extraction. */
export function sentimentClassifierIdentity(source: SentimentSourceAssessment): Pick<SentimentClassifierInput, 'subject' | 'language' | 'context'> {
  const edge = source.edges[0]!
  const subject = { id: source.subject.key, displayName: source.subject.name, aliases: source.subject.aliases, qualifiedAliases: source.subject.identityAliases, urls: source.subject.urls, mentionNotApplicable: source.subject.mentionNotApplicable }
  return {
    subject, language: source.language,
    context: { queryId: edge.queryKey, queryText: edge.queryText, queryClass: edge.queryClass, provider: edge.provider, requestedModel: edge.sourceModel, servedModel: edge.servedModel, location: edge.context?.label ?? null, locationContext: edge.context, revision: source.revision,
      usageEdges: source.edges.flatMap(item => (item.groupKeys.length ? item.groupKeys : [null]).flatMap(groupId => (item.marketKeys.length ? item.marketKeys : [null]).map(marketId => ({ queryId: item.queryKey, queryText: item.queryText, executionNodeKey: item.executionNodeKey, targetId: item.propertyKey, propertyId: source.revision === null ? null : item.propertyKey, groupId, marketId, queryClass: item.queryClass, location: item.context?.label ?? null })))),
    },
  }
}

/** Stored-work membership must match the original source bytes and frozen subject. */
export function sentimentSourceHashes(source: SentimentSourceAssessment, identity = sentimentClassifierIdentity(source)): Pick<SentimentClassifierInput, 'sourceTextHash' | 'subjectHash'> {
  return { sourceTextHash: sentimentHash(source.sourceText), subjectHash: sentimentHash({ subject: identity.subject, context: source.edges[0]!.context }) }
}

export function sentimentClassifierInput(source: SentimentSourceAssessment, definition: SentimentEvaluationDefinition): SentimentClassifierInput {
  const identity = sentimentClassifierIdentity(source)
  return {
    sourceSnapshotId: source.snapshotId, sourceText: source.sourceText,
    ...identity, ...sentimentSourceHashes(source, identity), definition,
    sentences: sentimentSentenceSpans(source.sourceText),
  }
}
