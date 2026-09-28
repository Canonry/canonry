import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createSentimentEvaluationDefinition, sentimentPresetThemes } from '../../packages/contracts/src/sentiment.js'
import { buildJevSentimentRequest } from '../../packages/integration-typesafe/src/classifier.js'
import type { SentimentClassifierInput, SentimentTheme } from '../../packages/contracts/src/sentiment.js'

const sourceText = 'North Hall is a great place to live. Parking is expensive.'
const firstEnd = sourceText.indexOf(' Parking')
const base: SentimentClassifierInput = {
  sourceSnapshotId: 'synthetic', sourceText, sourceTextHash: createHash('sha256').update(sourceText).digest('hex'), subjectHash: 'synthetic',
  subject: { id: 'north', displayName: 'North Hall', aliases: ['North Hall'], qualifiedAliases: ['North Hall, Chicago'], urls: ['https://north.example'], mentionNotApplicable: false },
  context: { queryId: 'synthetic', queryText: 'Is North Hall good?', queryClass: 'branded', provider: 'synthetic', requestedModel: null, servedModel: null, location: 'Chicago', locationContext: null, revision: 1, usageEdges: [] },
  language: 'en', definition: createSentimentEvaluationDefinition(), sentences: [{ id: 's1', text: sourceText.slice(0, firstEnd), start: 0, end: firstEnd }, { id: 's2', text: sourceText.slice(firstEnd + 1), start: firstEnd + 1, end: sourceText.length }],
}
const custom: SentimentTheme[] = Array.from({ length: 24 }, (_, index) => ({ id: `custom-${index}`, name: `Theme ${index} `.padEnd(80, 'x'), description: 'Synthetic custom definition. '.padEnd(400, 'x'), source: 'custom', evaluationStatus: 'custom-not-evaluated' }))
const report = Object.fromEntries([['default', sentimentPresetThemes()], ['multifamily', sentimentPresetThemes('multifamily')], ['maximum-custom', custom]].map(([name, themes]) => {
  const definition = createSentimentEvaluationDefinition(themes as SentimentTheme[])
  const built = buildJevSentimentRequest({ ...base, definition })
  return [name, { themeCount: definition.themes.length, accepted: built.ok, estimate: built.estimate ?? null, limitation: 'UTF-8 byte upper bound plus 1024 framing allowance, not the vendor tokenizer or returned usage. Official price checked 2026-09-28: USD 0.042/M input tokens.' }]
}))
await writeFile(process.argv[2] ?? 'evals/sentiment/token-estimates.json', JSON.stringify(report, null, 2) + '\n')
