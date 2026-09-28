import { createHash } from 'node:crypto'
import { canonicalSentimentJson, type SentimentClassifierInput, type SentimentEvaluationDefinition } from '@ainyc/canonry-contracts'
import type { SentimentSourceAssessment } from './sentiment-source.js'

export function sentimentHash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalSentimentJson(value)).digest('hex')
}
/** Stable spans preserve every source byte; sentence selection never invents quotations. */
export function sentimentSentenceSpans(text: string): SentimentClassifierInput['sentences'] {
  const spans: SentimentClassifierInput['sentences'] = []
  const expression = /[\s\S]+?(?:[.!?](?=\s|$)|\n+|$)/gu
  for (const match of text.matchAll(expression)) {
    const start = match.index + match[0].search(/\S/u)
    const end = match.index + match[0].trimEnd().length
    if (start < match.index || end <= start) continue
    spans.push({ id: `s${spans.length + 1}`, text: text.slice(start, end), start, end })
  }
  return spans
}
export function sentimentClassifierInput(source: SentimentSourceAssessment, definition: SentimentEvaluationDefinition): SentimentClassifierInput {
  const edge = source.edges[0]!
  const subject = { id: source.subject.key, displayName: source.subject.name, aliases: source.subject.aliases, qualifiedAliases: source.subject.identityAliases, urls: source.subject.urls, mentionNotApplicable: source.subject.mentionNotApplicable }
  return {
    sourceSnapshotId: source.snapshotId, sourceText: source.sourceText, sourceTextHash: sentimentHash(source.sourceText), subject,
    subjectHash: sentimentHash({ subject, context: edge.context }), language: source.language, definition,
    sentences: sentimentSentenceSpans(source.sourceText),
    context: { queryId: edge.queryKey, queryText: edge.queryText, queryClass: edge.queryClass, provider: edge.provider, requestedModel: edge.sourceModel, servedModel: edge.servedModel, location: edge.context?.label ?? null, locationContext: edge.context, revision: source.revision,
      usageEdges: source.edges.flatMap(item => (item.groupKeys.length ? item.groupKeys : [null]).flatMap(groupId => (item.marketKeys.length ? item.marketKeys : [null]).map(marketId => ({ queryId: item.queryKey, queryText: item.queryText, executionNodeKey: item.executionNodeKey, targetId: item.propertyKey, propertyId: source.revision === null ? null : item.propertyKey, groupId, marketId, queryClass: item.queryClass, location: item.context?.label ?? null })))),
    },
  }
}
