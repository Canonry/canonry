import { aggregateSentiment, createSentimentEvaluationDefinition, sentimentPresetThemes, type SentimentAggregateItem, type SentimentOutcome, type SentimentSummary } from '../../src/sentiment.js'

/** Synthetic shared cross-surface fixture. It carries no customer answers or identities. */
export const sentimentFixtureOutcomes: SentimentOutcome[] = ['favorable', 'favorable', 'favorable', 'mixed', 'unfavorable', 'factual', 'wrong-subject', 'invalid-conclusion-evidence', 'failed', 'pending']
export const sentimentFixtureTheme = sentimentPresetThemes()[2]!
export const sentimentFixtureItems: SentimentAggregateItem[] = sentimentFixtureOutcomes.map((outcome, i) => ({
  assessmentId: `assessment-${i}`, sourceSnapshotId: `snapshot-${i}`, outcome,
  themes: i < 3 ? [{ themeId: sentimentFixtureTheme.id, discussed: true, praised: i < 2, criticized: true, evidence: { discussed: [], praised: [], criticized: [] }, reason: null }] : [],
}))
export const sentimentFixtureDefinition = createSentimentEvaluationDefinition([sentimentFixtureTheme])
export const sentimentFixtureSummary: SentimentSummary = {
  ...aggregateSentiment(sentimentFixtureItems, [sentimentFixtureTheme]),
  reason: 'Classification is incomplete.',
  selection: { runId: 'run-fixture', revision: null, mode: 'simple', queryClass: 'branded', scope: 'project', evaluationDefinitionId: 'definition-fixture' },
  evaluationDefinition: sentimentFixtureDefinition, breakdowns: [],
}
export const sentimentCompleteFixtureSummary: SentimentSummary = {
  ...sentimentFixtureSummary,
  ...aggregateSentiment(sentimentFixtureItems.filter(item => item.outcome !== 'failed' && item.outcome !== 'pending'), [sentimentFixtureTheme]),
  reason: null,
}
