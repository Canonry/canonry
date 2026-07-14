import { describe, expect, it } from 'vitest'

import { buildModelAttribution } from '../src/analytics-model-attribution.js'
import { classifyModelEvidence } from '../src/model-evidence.js'

describe('classifyModelEvidence', () => {
  it('canonicalizes known, unknown, and mixed model evidence', () => {
    expect(classifyModelEvidence(['claude-sonnet-5', 'claude-sonnet-5'])).toEqual({
      status: 'known',
      model: 'claude-sonnet-5',
    })
    expect(classifyModelEvidence([null, ''])).toEqual({ status: 'unknown' })
    expect(classifyModelEvidence(['claude-sonnet-5', null, 'claude-opus-5'])).toEqual({
      status: 'mixed',
      models: ['claude-opus-5', 'claude-sonnet-5'],
      includesUnknown: true,
    })
  })
})

describe('buildModelAttribution', () => {
  it('groups same-time location runs and emits one deterministic observed transition', () => {
    const attribution = buildModelAttribution({
      observations: [
        {
          runId: 'run-2-us',
          runCreatedAt: '2026-03-20T12:00:00.000Z',
          provider: 'claude',
          model: 'claude-sonnet-5',
        },
        {
          runId: 'run-1',
          runCreatedAt: '2026-03-15T12:00:00.000Z',
          provider: 'claude',
          model: 'claude-opus-5',
        },
        {
          runId: 'run-2-eu',
          runCreatedAt: '2026-03-20T12:00:00.000Z',
          provider: 'claude',
          model: 'claude-sonnet-5',
        },
      ],
      bucketStartFor: () => '2026-03-01T00:00:00.000Z',
    })

    expect(attribution).toEqual({
      claude: {
        latestObservation: {
          observedAt: '2026-03-20T12:00:00.000Z',
          state: { status: 'known', model: 'claude-sonnet-5' },
        },
        events: [
          {
            observedAt: '2026-03-20T12:00:00.000Z',
            bucketStartDate: '2026-03-01T00:00:00.000Z',
            from: { status: 'known', model: 'claude-opus-5' },
            to: { status: 'known', model: 'claude-sonnet-5' },
          },
        ],
      },
    })
  })

  it('retains first-observed times, records unknown explicitly, and does not infer absence', () => {
    const attribution = buildModelAttribution({
      // Deliberately shuffled: output is chronological and provider-sorted.
      observations: [
        { runId: 'claude-5', runCreatedAt: '2026-07-14T12:00:00.000Z', provider: 'claude', model: 'claude-sonnet-5' },
        { runId: 'gemini-4', runCreatedAt: '2026-07-10T12:00:00.000Z', provider: 'gemini', model: 'gemini-2.5-flash' },
        { runId: 'claude-3', runCreatedAt: '2026-03-21T12:00:00.000Z', provider: 'claude', model: null },
        { runId: 'claude-1', runCreatedAt: '2026-03-15T12:00:00.000Z', provider: 'claude', model: 'claude-opus-5' },
        { runId: 'claude-2', runCreatedAt: '2026-03-20T12:00:00.000Z', provider: 'claude', model: 'claude-sonnet-5' },
      ],
      bucketStartFor: observedAt => observedAt.slice(0, 7) + '-01T00:00:00.000Z',
    })

    expect(attribution).toEqual({
      claude: {
        latestObservation: {
          observedAt: '2026-07-14T12:00:00.000Z',
          state: { status: 'known', model: 'claude-sonnet-5' },
        },
        events: [
          {
            observedAt: '2026-03-20T12:00:00.000Z',
            bucketStartDate: '2026-03-01T00:00:00.000Z',
            from: { status: 'known', model: 'claude-opus-5' },
            to: { status: 'known', model: 'claude-sonnet-5' },
          },
          {
            observedAt: '2026-03-21T12:00:00.000Z',
            bucketStartDate: '2026-03-01T00:00:00.000Z',
            from: { status: 'known', model: 'claude-sonnet-5' },
            to: { status: 'unknown' },
          },
          {
            observedAt: '2026-07-14T12:00:00.000Z',
            bucketStartDate: '2026-07-01T00:00:00.000Z',
            from: { status: 'unknown' },
            to: { status: 'known', model: 'claude-sonnet-5' },
          },
        ],
      },
      gemini: {
        latestObservation: {
          observedAt: '2026-07-10T12:00:00.000Z',
          state: { status: 'known', model: 'gemini-2.5-flash' },
        },
        events: [],
      },
    })
  })
})
