import { expect, it } from 'vitest'
import { agentPromptRequestSchema, agentVisibilityEvidence } from '../src/agent.js'
import { aeroEvidenceFixture } from './fixtures/aero-evidence.js'

it.each(['simple', 'advanced'] as const)('keeps %s observations, denominators, stale dates, and incompatible comparisons exact', mode => {
  const report = aeroEvidenceFixture(mode)
  const result = agentVisibilityEvidence(report, 'hotel & spa', '2026-09-22T00:00:00.000Z')
  expect(result.source.measuredAt).toBe('2026-08-01T00:00:00.000Z')
  expect(result.source.retrievedAt).toBe('2026-09-22T00:00:00.000Z')
  expect(result.populations.map(population => [population.queryClass, population.summary.mentionCoverage])).toEqual([
    ['branded', { numerator: 10, denominator: 10, rate: 1 }],
    ['non-brand', { numerator: 0, denominator: 10, rate: 0 }],
    ['unknown', { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' }],
  ])
  expect(result.populations[1].summary.citationCoverage).toEqual({ numerator: 2, denominator: 10, rate: 0.2 })
  expect(result.populations[1].comparison).toEqual(report.populations[1].comparison)
  expect(result.populations[1].evidence).toMatchObject({ total: 10, nextCursor: 'evidence-page-2' })
  const source = new URL(result.source.path, 'https://example.test/canonry/')
  expect(source.pathname).toBe('/canonry/projects/hotel%20%26%20spa')
  expect(source.searchParams.get('measurementRunId')).toBe('run-3')
  expect(source.searchParams.get('measurementLocation')).toBe('none')
  expect(source.searchParams.get('queryClass')).toBe('all')
  if (mode === 'advanced') {
    expect(source.searchParams.get('measurementScopeKey')).toBe('hotel')
    expect(source.searchParams.get('measurementMarketKey')).toBe('london')
    expect(source.searchParams.get('measurementRevision')).toBe('3')
  }
})

it('leaves missing historical comparisons unavailable and omits large answer bodies from overview evidence', () => {
  const report = aeroEvidenceFixture()
  delete report.populations[0].comparison
  report.populations[0].evidence.items.push({ answerId: 'a1', queryKey: 'q1', runId: 'run-3', query: 'Hotels', provider: 'openai', model: null, location: null, targetKeys: ['hotel'], mentioned: null, cited: false, answerText: 'x'.repeat(100_000), sources: [], observedCompetitors: [], createdAt: '2026-08-01T00:00:00.000Z' })
  const result = agentVisibilityEvidence(report, 'demo', '2026-09-22T00:00:00.000Z')
  expect(result.populations[0].comparison).toBeNull()
  expect(result.observations[0]).toMatchObject({ mentioned: null, cited: false, answerId: 'a1' })
  expect(result.observations[0]).not.toHaveProperty('answerText')
})

it('validates scoped context and bounded limits without accepting cross-project authority', () => {
  expect(agentPromptRequestSchema.safeParse({ prompt: 'Why?', context: { view: 'visibility', selection: { scope: 'property' } } }).success).toBe(false)
  expect(agentPromptRequestSchema.safeParse({ prompt: 'Why?', context: { view: 'project', project: 'other' } }).success).toBe(false)
  expect(agentPromptRequestSchema.safeParse({ prompt: 'Why?', limits: { maxToolCalls: 101 } }).success).toBe(false)
  expect(agentPromptRequestSchema.parse({ prompt: 'Why?', limits: {} }).limits).toEqual({ maxToolCalls: 30, timeoutMs: 180000 })
})
