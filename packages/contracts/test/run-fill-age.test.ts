import { describe, expect, it } from 'vitest'
import { runFillAgeAnchor } from '../src/run-fill.js'

const CREATED = '2026-09-24T00:00:00.000Z'
const STARTED = '2026-09-24T00:00:02.000Z'
const FINISHED = '2026-09-24T21:30:00.000Z'

describe('runFillAgeAnchor', () => {
  it('measures an ordinary run from when it started', () => {
    expect(runFillAgeAnchor({ createdAt: CREATED, startedAt: STARTED, finishedAt: FINISHED }, { hadProviderBatch: false }))
      .toEqual({ anchor: STARTED, basis: 'started' })
  })

  it('falls back to creation for an ordinary run that never recorded a start', () => {
    expect(runFillAgeAnchor({ createdAt: CREATED, startedAt: null, finishedAt: FINISHED }, { hadProviderBatch: false }))
      .toEqual({ anchor: CREATED, basis: 'started' })
  })

  it('measures a run that dispatched a provider batch from when it finalized', () => {
    expect(runFillAgeAnchor({ createdAt: CREATED, startedAt: STARTED, finishedAt: FINISHED }, { hadProviderBatch: true }))
      .toEqual({ anchor: FINISHED, basis: 'finished' })
  })

  it('falls back to the old anchor for a batch run with no finish time', () => {
    expect(runFillAgeAnchor({ createdAt: CREATED, startedAt: STARTED, finishedAt: null }, { hadProviderBatch: true }))
      .toEqual({ anchor: STARTED, basis: 'started' })
    expect(runFillAgeAnchor({ createdAt: CREATED, startedAt: null, finishedAt: null }, { hadProviderBatch: true }))
      .toEqual({ anchor: CREATED, basis: 'started' })
  })
})
