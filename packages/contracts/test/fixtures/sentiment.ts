import { aggregateSentiment, createSentimentEvaluationDefinition, type SentimentAggregateItem, type SentimentOutcome, type SentimentSummary } from '../../src/sentiment.js'

/** Synthetic shared cross-surface fixture. It carries no customer answers or identities. */
export const sentimentFixtureOutcomes: SentimentOutcome[] = ['favorable', 'favorable', 'favorable', 'mixed', 'unfavorable', 'factual', 'wrong-subject', 'invalid-conclusion-evidence', 'failed', 'pending']
export const sentimentFixtureItems: SentimentAggregateItem[] = sentimentFixtureOutcomes.map((outcome, i) => ({
  assessmentId: `assessment-${i}`, sourceSnapshotId: `snapshot-${i}`, outcome,
}))
export const sentimentFixtureDefinition = createSentimentEvaluationDefinition()
export const sentimentFixtureSummary: SentimentSummary = {
  ...aggregateSentiment(sentimentFixtureItems),
  reason: 'Classification is incomplete.', configured: true,
  selection: { runId: 'run-fixture', revision: null, mode: 'simple', queryClass: 'branded', scope: 'project', evaluationDefinitionId: 'definition-fixture' },
  evaluationDefinition: sentimentFixtureDefinition, breakdowns: [], queries: [],
}
export const sentimentCompleteFixtureSummary: SentimentSummary = {
  ...sentimentFixtureSummary,
  ...aggregateSentiment(sentimentFixtureItems.filter(item => item.outcome !== 'failed' && item.outcome !== 'pending')),
  reason: null,
}
