import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createSentimentEvaluationDefinition } from '../../packages/contracts/src/sentiment.js'
import { buildJevSentimentRequest } from '../../packages/integration-typesafe/src/classifier.js'
import type { SentimentClassifierInput } from '../../packages/contracts/src/sentiment.js'

const sourceText = 'North Hall is a great place to live. Parking is expensive.'
const firstEnd = sourceText.indexOf(' Parking')
const base: SentimentClassifierInput = {
  sourceSnapshotId: 'synthetic', sourceText, sourceTextHash: createHash('sha256').update(sourceText).digest('hex'), subjectHash: 'synthetic',
  subject: { id: 'north', displayName: 'North Hall', aliases: ['North Hall'], qualifiedAliases: ['North Hall, Chicago'], urls: ['https://north.example'], mentionNotApplicable: false },
  context: { queryId: 'synthetic', queryText: 'Is North Hall good?', queryClass: 'branded', provider: 'synthetic', requestedModel: null, servedModel: null, location: 'Chicago', locationContext: null, revision: 1, usageEdges: [] },
  language: 'en', definition: createSentimentEvaluationDefinition(), sentences: [{ id: 's1', text: sourceText.slice(0, firstEnd), start: 0, end: firstEnd }, { id: 's2', text: sourceText.slice(firstEnd + 1), start: firstEnd + 1, end: sourceText.length }],
}
const report = Object.fromEntries((['branded', 'non-brand', 'non-brand-subject-absent'] as const).map(name => {
  const queryClass = name === 'branded' ? 'branded' : 'non-brand'
  const sourceText = name === 'non-brand-subject-absent' ? 'South Hall is a great place to live.' : base.sourceText
  const input: SentimentClassifierInput = { ...base, context: { ...base.context, queryClass, queryText: queryClass === 'branded' ? base.context.queryText : 'Which apartment buildings are good in Chicago?' }, sourceText, sourceTextHash: createHash('sha256').update(sourceText).digest('hex'), sentences: sourceText === base.sourceText ? base.sentences : [{ id: 's1', text: sourceText, start: 0, end: sourceText.length }] }
  const built = buildJevSentimentRequest(input)
  return [name, { queryClass, providerRequestRequired: built.ok, outcome: built.ok ? null : built.outcome, questions: built.ok ? Object.keys(built.request.questions) : [], estimate: built.estimate ?? null, limitation: 'UTF-8 byte upper bound plus 1024 framing allowance, not the vendor tokenizer or returned usage. Official price checked 2026-09-28: USD 0.042/M input tokens.' }]
}))
await writeFile(process.argv[2] ?? 'evals/sentiment/token-estimates.json', JSON.stringify(report, null, 2) + '\n')
