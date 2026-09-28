import { createHash } from 'node:crypto'
import { canonicalSentimentJson, createSentimentEvaluationDefinition } from '@ainyc/canonry-contracts'
import type { SentimentClassifierInput } from '@ainyc/canonry-contracts'
import type { JevRequest } from '../src/client.js'

export function inputFixture(): SentimentClassifierInput {
  const sourceText = 'North Hall is a great place to live. Parking is expensive.'
  const subject = { id: 'north', displayName: 'North Hall', aliases: ['North Hall'], qualifiedAliases: ['North Hall, Chicago'], urls: ['https://north.example'], mentionNotApplicable: false }
  return {
    sourceSnapshotId: 'snapshot', sourceText, sourceTextHash: createHash('sha256').update(sourceText).digest('hex'),
    subject, subjectHash: createHash('sha256').update(canonicalSentimentJson(subject)).digest('hex'),
    context: { queryId: 'query', queryText: 'Is North Hall good?', queryClass: 'branded', provider: 'openai', requestedModel: 'source-model', servedModel: 'source-model', location: 'Chicago', locationContext: null, revision: 1, usageEdges: [] },
    language: 'en', definition: createSentimentEvaluationDefinition([{ id: 'price', name: 'Price', description: 'Cost and value', source: 'default', evaluationStatus: 'experimental' }]),
    sentences: [{ id: 's1', text: 'North Hall is a great place to live.', start: 0, end: sourceText.indexOf(' Parking') }, { id: 's2', text: 'Parking is expensive.', start: sourceText.indexOf('Parking'), end: sourceText.length }],
  }
}
export function responseFixture(request: JevRequest, overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = { identity: 'correct', judgment: 'judged', stance: 'favorable', conclusion: 's1', complaint: 's2', theme_0_discussed: 'yes', theme_0_praised: 'no', theme_0_criticized: 'yes', theme_0_discussed_evidence: 's2', theme_0_praised_evidence: 'absent', theme_0_criticized_evidence: 's2' }
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const choice = overrides[id] ?? defaults[id] ?? 'absent'
    return [id, { type: 'choice', choice, confidence: 0.8, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }]
  }))
  return { model: request.model, answers, usage: { input_tokens: 500, output_tokens: 100 } }
}
