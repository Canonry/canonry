import { describe, expect, it } from 'vitest'
import {
  researchPromotionCommitRequestSchema,
  researchPromotionCommitResultSchema,
  researchPromotionPreviewRequestSchema,
  researchPromotionPreviewResponseSchema,
} from '../src/research-promotion.js'

const checksum = 'a'.repeat(64)

describe('research promotion contracts', () => {
  it('keeps the optional advanced selection strict and bounded to known classes', () => {
    expect(researchPromotionPreviewRequestSchema.parse({
      targetKeys: ['target-a'],
      groupKeys: ['group-a'],
      queryClass: 'non-brand',
    })).toEqual({ targetKeys: ['target-a'], groupKeys: ['group-a'], queryClass: 'non-brand' })

    expect(researchPromotionPreviewRequestSchema.safeParse({ queryClass: 'unclassified' }).success).toBe(false)
    expect(researchPromotionPreviewRequestSchema.safeParse({ targetKeys: ['target-a'], extra: true }).success).toBe(false)
  })

  it('models a refusal without answer or provider evidence and validates the future commit guard', () => {
    const refusal = {
      mode: 'refused',
      source: {
        runId: 'research-run-a',
        queryId: 'research-query-a',
        query: 'compare sample options',
        normalizedQuery: 'compare sample options',
        status: 'completed',
        completedAt: '2026-08-28T00:00:00.000Z',
      },
      trackedQuery: {
        state: 'new',
        id: 'research-promotion-a',
        proposedId: 'research-promotion-a',
        query: 'compare sample options',
        normalizedQuery: 'compare sample options',
      },
      setup: {
        state: 'republish_required',
        mode: 'active-v1',
        activeRevision: 3,
        activeCompiledChecksum: null,
        draftEtag: null,
      },
      refusal: { reason: 'active-v1', message: 'Publish a v2 measurement plan before assigning this query.' },
      previewChecksum: checksum,
    }

    expect(researchPromotionPreviewResponseSchema.parse(refusal)).toEqual(refusal)
    expect(researchPromotionPreviewResponseSchema.safeParse({ ...refusal, answerText: 'must not appear' }).success).toBe(false)
    const commitRequest = {
      previewChecksum: checksum,
      request: { targetKeys: ['target-a'], groupKeys: ['group-a'], queryClass: 'non-brand' },
    }
    expect(researchPromotionCommitRequestSchema.parse(commitRequest)).toEqual(commitRequest)
    expect(researchPromotionCommitRequestSchema.safeParse({ previewChecksum: checksum }).success).toBe(false)
    expect(researchPromotionCommitRequestSchema.safeParse({ ...commitRequest, request: { queryClass: 'unclassified' } }).success).toBe(false)
    expect(researchPromotionCommitRequestSchema.safeParse({ ...commitRequest, extra: true }).success).toBe(false)
    expect(researchPromotionCommitRequestSchema.safeParse({ ...commitRequest, previewChecksum: 'not-a-checksum' }).success).toBe(false)
    expect(researchPromotionCommitResultSchema.safeParse({
      status: 'tracked-awaiting-first-sweep',
      mode: 'simple',
      trackedQuery: refusal.trackedQuery,
      source: refusal.source,
      publishedRevision: null,
      compiledChecksum: null,
    }).success).toBe(true)

    const alreadyTracked = {
      status: 'already-tracked',
      mode: 'advanced',
      trackedQuery: { ...refusal.trackedQuery, state: 'existing' },
      source: refusal.source,
      publishedRevision: null,
      compiledChecksum: null,
    }
    expect(researchPromotionCommitResultSchema.parse(alreadyTracked)).toEqual(alreadyTracked)
    expect(researchPromotionCommitResultSchema.safeParse({
      ...alreadyTracked,
      publishedRevision: 4,
    }).success).toBe(false)
  })
})
