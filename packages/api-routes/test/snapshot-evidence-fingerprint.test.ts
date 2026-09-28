import { describe, expect, it } from 'vitest'
import type { querySnapshots } from '@ainyc/canonry-db'
import { snapshotEvidenceFingerprint } from '../src/snapshot-evidence-fingerprint.js'

type SnapshotRow = typeof querySnapshots.$inferSelect

function row(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    id: 'snap-1',
    runId: 'run-1',
    queryId: 'q-1',
    queryText: 'best widgets',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    servedModel: null,
    citationState: 'cited',
    answerMentioned: true,
    answerText: 'Acme is a good pick.',
    citedDomains: ['acme.com'],
    citedUrls: null,
    captureStatus: null,
    sourceCount: null,
    resolvedCount: null,
    captureVersion: null,
    retrievalStatus: null,
    retrievalContract: null,
    competitorOverlap: [],
    recommendedCompetitors: [],
    location: null,
    measurementExecutionId: 'exec-1',
    requestedContext: null,
    supportedContext: null,
    screenshotPath: null,
    rawResponse: null,
    dispatchMode: null,
    providerBatchId: null,
    stopReason: null,
    usage: null,
    createdAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  }
}

describe('snapshotEvidenceFingerprint', () => {
  it('ignores how an answer was dispatched and what it cost', () => {
    const before = snapshotEvidenceFingerprint([row()])
    expect(snapshotEvidenceFingerprint([row({
      dispatchMode: 'batch',
      providerBatchId: 'batch-1',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, searchCount: 1,
        pricingTier: 'batch', estimatedCostMicros: 10, priceSource: 'default',
      },
    })])).toBe(before)
  })

  it('changes when what the answer said changes, and ignores row order', () => {
    const second = row({ id: 'snap-2', provider: 'openai' })
    expect(snapshotEvidenceFingerprint([row({ answerText: 'Acme is not recommended.' })])).not.toBe(snapshotEvidenceFingerprint([row()]))
    expect(snapshotEvidenceFingerprint([second, row()])).toBe(snapshotEvidenceFingerprint([row(), second]))
  })
})
