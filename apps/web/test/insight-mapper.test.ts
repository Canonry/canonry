import { test, expect, describe } from 'vitest'

import type { InsightDto } from '@ainyc/canonry-contracts'
import { mapInsightDtoToVm, mapInsightDtosToVms } from '../src/mappers/insight-mapper.js'

/* ── helpers ─────────────────────────────────────────── */

function makeInsightDto(overrides: Partial<InsightDto> = {}): InsightDto {
  return {
    id: 'ins_1',
    projectId: 'proj_1',
    runId: 'run_1',
    type: 'regression',
    severity: 'high',
    title: 'Lost citation on ChatGPT',
    keyword: 'roof repair phoenix',
    provider: 'chatgpt',
    recommendation: { action: 'Re-submit to index', reason: 'Page not re-indexed' },
    cause: { cause: 'competitor displacement', competitorDomain: 'rival.com', details: 'rival.com now cited instead' },
    dismissed: false,
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

/* ── tone mapping ────────────────────────────────────── */

describe('mapInsightDtoToVm', () => {
  describe('type → tone mapping', () => {
    test('regression → negative', () => {
      const vm = mapInsightDtoToVm(makeInsightDto({ type: 'regression' }))
      expect(vm.tone).toBe('negative')
    })

    test('gain → positive', () => {
      const vm = mapInsightDtoToVm(makeInsightDto({ type: 'gain' }))
      expect(vm.tone).toBe('positive')
    })

    test('opportunity → caution', () => {
      const vm = mapInsightDtoToVm(makeInsightDto({ type: 'opportunity' }))
      expect(vm.tone).toBe('caution')
    })
  })

  /* ── core fields ─────────────────────────────────────── */

  test('preserves id and title', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({ id: 'ins_42', title: 'Lost it all' }))
    expect(vm.id).toBe('ins_42')
    expect(vm.title).toBe('Lost it all')
  })

  /* ── affected phrases ────────────────────────────────── */

  test('builds single affected phrase from keyword + provider', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({
      keyword: 'best roofing',
      provider: 'gemini',
      type: 'regression',
    }))
    expect(vm.affectedPhrases).toHaveLength(1)
    expect(vm.affectedPhrases[0]!.keyword).toBe('best roofing')
    expect(vm.affectedPhrases[0]!.provider).toBe('gemini')
  })

  test('regression → citationState lost', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({ type: 'regression' }))
    expect(vm.affectedPhrases[0]!.citationState).toBe('lost')
  })

  test('gain → citationState emerging', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({ type: 'gain' }))
    expect(vm.affectedPhrases[0]!.citationState).toBe('emerging')
  })

  test('opportunity → citationState not-cited', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({ type: 'opportunity' }))
    expect(vm.affectedPhrases[0]!.citationState).toBe('not-cited')
  })

  test('affected phrase evidenceId is empty (no evidence linkage from DB insights)', () => {
    const vm = mapInsightDtoToVm(makeInsightDto())
    expect(vm.affectedPhrases[0]!.evidenceId).toBe('')
  })

  /* ── recommendation → actionLabel ────────────────────── */

  test('recommendation.action → actionLabel', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({
      recommendation: { action: 'Re-submit to index', reason: 'stale' },
    }))
    expect(vm.actionLabel).toBe('Re-submit to index')
  })

  test('missing recommendation → type-based fallback actionLabel', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({ type: 'regression', recommendation: undefined }))
    expect(vm.actionLabel).toBe('Regression')
  })

  test('gain without recommendation → "Gain" actionLabel', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({ type: 'gain', recommendation: undefined }))
    expect(vm.actionLabel).toBe('Gain')
  })

  test('opportunity without recommendation → "Opportunity" actionLabel', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({ type: 'opportunity', recommendation: undefined }))
    expect(vm.actionLabel).toBe('Opportunity')
  })

  /* ── cause → detail ──────────────────────────────────── */

  test('cause.details → detail', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({
      cause: { cause: 'displacement', details: 'rival.com now cited instead' },
    }))
    expect(vm.detail).toBe('rival.com now cited instead')
  })

  test('cause without details falls back to cause.cause', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({
      cause: { cause: 'content drift' },
    }))
    expect(vm.detail).toBe('content drift')
  })

  test('missing cause → empty detail', () => {
    const vm = mapInsightDtoToVm(makeInsightDto({ cause: undefined }))
    expect(vm.detail).toBe('')
  })

  /* ── evidenceId ──────────────────────────────────────── */

  test('evidenceId is undefined (no evidence linkage from DB insights)', () => {
    const vm = mapInsightDtoToVm(makeInsightDto())
    expect(vm.evidenceId).toBeUndefined()
  })
})

/* ── batch mapping ───────────────────────────────────── */

describe('mapInsightDtosToVms', () => {
  test('maps array of DTOs', () => {
    const dtos = [
      makeInsightDto({ id: 'ins_1', type: 'regression' }),
      makeInsightDto({ id: 'ins_2', type: 'gain' }),
    ]
    const vms = mapInsightDtosToVms(dtos)
    expect(vms).toHaveLength(2)
    expect(vms[0]!.tone).toBe('negative')
    expect(vms[1]!.tone).toBe('positive')
  })

  test('filters out dismissed insights', () => {
    const dtos = [
      makeInsightDto({ id: 'ins_1', dismissed: false }),
      makeInsightDto({ id: 'ins_2', dismissed: true }),
      makeInsightDto({ id: 'ins_3', dismissed: false }),
    ]
    const vms = mapInsightDtosToVms(dtos)
    expect(vms).toHaveLength(2)
    expect(vms.map(v => v.id)).toEqual(['ins_1', 'ins_3'])
  })

  test('returns empty array for empty input', () => {
    expect(mapInsightDtosToVms([])).toEqual([])
  })
})
