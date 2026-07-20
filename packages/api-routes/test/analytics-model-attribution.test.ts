import { describe, expect, it } from 'vitest'
import { MODEL_ATTRIBUTION_EVENT_LIMIT } from '@ainyc/canonry-contracts'

import { buildModelAttribution, buildServedModelAttribution } from '../src/analytics-model-attribution.js'
import { classifyModelEvidence, modelEvidenceMismatched } from '../src/model-evidence.js'

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

  it('dates an anchor-derived transition to the anchor sweep, not the window', () => {
    const attribution = buildModelAttribution({
      observations: [
        { runId: 'run-1', runCreatedAt: '2026-07-15T12:00:00.000Z', provider: 'perplexity', model: 'sonar-pro' },
        { runId: 'run-2', runCreatedAt: '2026-07-17T12:00:00.000Z', provider: 'perplexity', model: 'sonar-reasoning' },
      ],
      anchors: { perplexity: { status: 'known', model: 'sonar' } },
      anchorObservedAt: { perplexity: '2026-03-01T12:00:00.000Z' },
      bucketStartFor: observedAt => observedAt.slice(0, 10) + 'T00:00:00.000Z',
    })

    const events = attribution.perplexity!.events
    // Closed range: the change happened after the anchor sweep and on or
    // before the first in-window sweep. Only the anchor-derived event carries
    // it — a sweep-to-sweep transition is already exactly dated.
    expect(events[0]!.anchorObservedAt).toBe('2026-03-01T12:00:00.000Z')
    expect(events[1]!.anchorObservedAt).toBeUndefined()
  })

  it('reports anchorUnavailable only for providers the anchor search could not resolve', () => {
    const attribution = buildModelAttribution({
      observations: [
        { runId: 'run-1', runCreatedAt: '2026-07-15T12:00:00.000Z', provider: 'gemini', model: 'gemini-2.5-flash' },
        { runId: 'run-1', runCreatedAt: '2026-07-15T12:00:00.000Z', provider: 'openai', model: 'gpt-5' },
      ],
      anchors: { openai: { status: 'known', model: 'gpt-5' } },
      anchorUnavailable: new Set(['gemini']),
      bucketStartFor: observedAt => observedAt,
    })

    expect(attribution.gemini!.anchorUnavailable).toBe(true)
    // Omitted, not `false`, so an unchanged history stays a clean object.
    expect(attribution.openai!.anchorUnavailable).toBeUndefined()
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

  it.each([
    { flips: MODEL_ATTRIBUTION_EVENT_LIMIT - 1, truncated: false },
    { flips: MODEL_ATTRIBUTION_EVENT_LIMIT, truncated: false },
    { flips: MODEL_ATTRIBUTION_EVENT_LIMIT + 1, truncated: true },
  ])('slices at the cap boundary: $flips transitions', ({ flips, truncated }) => {
    // The cap uses a strict `>`, so exactly the limit must be returned whole.
    // Off-by-one here would make a full list report itself as truncated and
    // drop the oldest real transition.
    const observations = Array.from({ length: flips + 1 }, (_, index) => ({
      runId: `run-${index}`,
      runCreatedAt: new Date(Date.UTC(2026, 4, 1 + index)).toISOString(),
      provider: 'openai',
      model: index % 2 === 0 ? 'gpt-5' : 'gpt-5-mini',
    }))

    const entry = buildModelAttribution({ observations, bucketStartFor: observedAt => observedAt }).openai!

    expect(entry.eventTotal).toBe(flips)
    expect(entry.events).toHaveLength(truncated ? MODEL_ATTRIBUTION_EVENT_LIMIT : flips)
    expect(entry.events.length < entry.eventTotal!).toBe(truncated)
    // The first transition survives untruncated and is lost at the boundary+1.
    expect(entry.events[0]!.observedAt === observations[1]!.runCreatedAt).toBe(!truncated)
  })
})

describe('buildServedModelAttribution', () => {
  const sweep = (runCreatedAt: string, model: string, provider = 'openai') => ({
    runId: `run-${runCreatedAt}-${model}`,
    runCreatedAt,
    provider,
    model,
  })

  it('emits NOTHING when the served id only changes its dated snapshot suffix', () => {
    // The founder rule: a dated snapshot is the same model. Without this, every
    // provider-side redeploy would read as a model change on every project.
    const served = buildServedModelAttribution({
      observations: [
        sweep('2026-03-01T12:00:00.000Z', 'gpt-5.4-2026-01-09'),
        sweep('2026-03-08T12:00:00.000Z', 'gpt-5.4-2026-03-05'),
      ],
      bucketStartFor: observedAt => observedAt.slice(0, 10),
    })

    expect(served.openai!.events).toEqual([])
    expect(served.openai!.latestObservation.state).toEqual({ status: 'known', model: 'gpt-5.4' })
    // The full served string is never lost — it is what forensics needs.
    expect(served.openai!.latestServedModelIds).toEqual(['gpt-5.4-2026-03-05'])
  })

  it('emits a change when the served id swaps capability tier', () => {
    const served = buildServedModelAttribution({
      observations: [
        sweep('2026-03-01T12:00:00.000Z', 'gpt-5.6'),
        sweep('2026-03-08T12:00:00.000Z', 'gpt-5.6-sol'),
      ],
      bucketStartFor: observedAt => observedAt.slice(0, 10),
    })

    expect(served.openai!.events).toEqual([{
      observedAt: '2026-03-08T12:00:00.000Z',
      bucketStartDate: '2026-03-08',
      from: { status: 'known', model: 'gpt-5.6' },
      to: { status: 'known', model: 'gpt-5.6-sol' },
    }])
  })

  it('collapses two dated snapshots inside one sweep instead of reporting mixed evidence', () => {
    const served = buildServedModelAttribution({
      observations: [
        sweep('2026-03-08T12:00:00.000Z', 'gpt-5.4-2026-03-05'),
        sweep('2026-03-08T12:00:00.000Z', 'gpt-5.4-2026-03-06'),
      ],
      bucketStartFor: observedAt => observedAt.slice(0, 10),
    })

    expect(served.openai!.latestObservation.state).toEqual({ status: 'known', model: 'gpt-5.4' })
    expect(served.openai!.latestServedModelIds).toEqual(['gpt-5.4-2026-03-05', 'gpt-5.4-2026-03-06'])
  })

  it('is empty — with no bootstrap event — when nothing in the window was captured', () => {
    // Capture starts at a deploy boundary. The caller drops uncaptured
    // snapshots, so an all-null window is simply no observation.
    expect(buildServedModelAttribution({
      observations: [],
      bucketStartFor: () => '2026-03-01',
    })).toEqual({})
  })

  it('does not fabricate a change when capture starts mid-window', () => {
    // Sweep 1 has no served ids at all (filtered out by the caller); sweep 2 is
    // the first captured one. There is no prior served state to differ from, so
    // the first captured observation must not emit a transition.
    const served = buildServedModelAttribution({
      observations: [sweep('2026-03-08T12:00:00.000Z', 'gpt-5.4-2026-03-05')],
      bucketStartFor: observedAt => observedAt.slice(0, 10),
    })

    expect(served.openai!.events).toEqual([])
    expect(served.openai!.latestObservation.observedAt).toBe('2026-03-08T12:00:00.000Z')
  })

  it('dates a served change inherited from a pre-window anchor outside the window', () => {
    const served = buildServedModelAttribution({
      observations: [sweep('2026-03-08T12:00:00.000Z', 'gpt-5.6-sol')],
      anchors: { openai: { status: 'known', model: 'gpt-5.6' } },
      anchorObservedAt: { openai: '2026-03-01T12:00:00.000Z' },
      bucketStartFor: observedAt => observedAt.slice(0, 10),
    })

    expect(served.openai!.events).toEqual([{
      observedAt: '2026-03-08T12:00:00.000Z',
      bucketStartDate: '2026-03-08',
      from: { status: 'known', model: 'gpt-5.6' },
      to: { status: 'known', model: 'gpt-5.6-sol' },
      fromPreWindowAnchor: true,
      anchorObservedAt: '2026-03-01T12:00:00.000Z',
    }])
  })
})

describe('modelEvidenceMismatched', () => {
  it('reads a dated snapshot of the configured model as agreement', () => {
    expect(modelEvidenceMismatched(
      { status: 'known', model: 'gpt-5.4' },
      { status: 'known', model: 'gpt-5.4-2026-03-05' },
    )).toBe(false)
  })

  it('reads a tier substitution as a real mismatch', () => {
    expect(modelEvidenceMismatched(
      { status: 'known', model: 'gpt-5.6' },
      { status: 'known', model: 'gpt-5.6-sol' },
    )).toBe(true)
  })

  it('never claims a mismatch from partial evidence', () => {
    expect(modelEvidenceMismatched({ status: 'unknown' }, { status: 'known', model: 'gpt-5.6' })).toBe(false)
    expect(modelEvidenceMismatched(
      { status: 'known', model: 'gpt-5.6' },
      { status: 'mixed', models: ['gpt-5.6', 'gpt-5.6-sol'], includesUnknown: false },
    )).toBe(false)
  })
})
