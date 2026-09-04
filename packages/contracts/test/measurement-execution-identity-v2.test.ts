import { describe, expect, it } from 'vitest'
import {
  buildMeasurementExecutionIdentity,
  canonicalMeasurementExecutionIdentityJson,
  parseStoredMeasurementExecutionIdentity,
} from '../src/measurement-plan.js'

const CHECKSUM = 'a'.repeat(64)
const POLICY = 'b'.repeat(64)

describe('measurement execution identity v2', () => {
  it('parses legacy v1 identities unchanged', () => {
    const legacy = {
      schemaVersion: 1,
      providers: ['openai'],
      models: { openai: 'gpt-5.4' },
      checksum: CHECKSUM,
    }

    expect(parseStoredMeasurementExecutionIdentity(JSON.stringify(legacy))).toEqual(legacy)
  })

  it('freezes a requested route revision and policy separately from the requested model', () => {
    const identity = buildMeasurementExecutionIdentity({
      providers: ['route:research'],
      models: { 'route:research': 'openai/gpt-5.4' },
      routes: {
        'route:research': {
          routeId: 'route:research',
          routeRevision: 3,
          policyFingerprint: POLICY,
          requestedProvider: 'route:research',
          requestedModel: 'openai/gpt-5.4',
        },
      },
    }, CHECKSUM)

    expect(identity).toMatchObject({
      schemaVersion: 2,
      providers: ['route:research'],
      models: { 'route:research': 'openai/gpt-5.4' },
      routes: {
        'route:research': {
          routeId: 'route:research', routeRevision: 3,
          policyFingerprint: POLICY, requestedModel: 'openai/gpt-5.4',
        },
      },
    })
    expect(canonicalMeasurementExecutionIdentityJson({
      providers: ['route:research'],
      models: { 'route:research': 'openai/gpt-5.4' },
      routes: identity.routes,
    })).toContain('"schemaVersion":2')
  })
})
