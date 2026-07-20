import { describe, expect, it } from 'vitest'
import { MODEL_ATTRIBUTION_EVENT_LIMIT } from '@ainyc/canonry-contracts'

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
        eventTotal: 1,
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
        eventTotal: 3,
      },
      gemini: {
        latestObservation: {
          observedAt: '2026-07-10T12:00:00.000Z',
          state: { status: 'known', model: 'gemini-2.5-flash' },
        },
        events: [],
        eventTotal: 0,
      },
    })
  })

  it('flags only the transition whose `from` is the pre-window anchor', () => {
    const attribution = buildModelAttribution({
      observations: [
        { runId: 'run-1', runCreatedAt: '2026-07-15T12:00:00.000Z', provider: 'perplexity', model: 'sonar-pro' },
        { runId: 'run-2', runCreatedAt: '2026-07-17T12:00:00.000Z', provider: 'perplexity', model: 'sonar-reasoning' },
      ],
      anchors: { perplexity: { status: 'known', model: 'sonar' } },
      bucketStartFor: observedAt => observedAt.slice(0, 10) + 'T00:00:00.000Z',
    })

    const events = attribution.perplexity!.events
    expect(events).toHaveLength(2)
    // The anchor is pre-window evidence: the change is datable only to
    // "on or before" this sweep, so consumers must not read it as in-window.
    expect(events[0]!.fromPreWindowAnchor).toBe(true)
    expect(events[1]!.fromPreWindowAnchor).toBeUndefined()
  })

  it('caps events at the contract limit while reporting the true total', () => {
    // A provider serving two model ids during a rollout flips on every sweep.
    const flips = MODEL_ATTRIBUTION_EVENT_LIMIT + 20
    const observations = Array.from({ length: flips + 1 }, (_, index) => ({
      runId: `run-${index}`,
      runCreatedAt: new Date(Date.UTC(2026, 4, 1 + index)).toISOString(),
      provider: 'openai',
      model: index % 2 === 0 ? 'gpt-5' : 'gpt-5-mini',
    }))

    const attribution = buildModelAttribution({
      observations,
      bucketStartFor: observedAt => observedAt,
    })

    const entry = attribution.openai!
    expect(entry.eventTotal).toBe(flips)
    expect(entry.events).toHaveLength(MODEL_ATTRIBUTION_EVENT_LIMIT)
    // The most recent transitions are kept, and the retained tail stays
    // chronological so the truncation reads as "showing the latest N of M".
    expect(entry.events[entry.events.length - 1]!.observedAt).toBe(observations[flips]!.runCreatedAt)
    expect(entry.events.map(event => event.observedAt))
      .toEqual([...entry.events.map(event => event.observedAt)].sort())
  })
})
