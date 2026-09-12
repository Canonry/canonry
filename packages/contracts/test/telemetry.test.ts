import { describe, expect, it } from 'vitest'
import {
  bucketOnboardingCount,
  isGhostTelemetryEvent,
  normalizeOnboardingEventForCollection,
  normalizeTelemetryStatus,
  onboardingTelemetryEventSchema,
  telemetryStatusDtoSchema,
} from '../src/telemetry.js'

describe('isGhostTelemetryEvent', () => {
  it('flags no-provider run.completed / run.aborted from every test location', () => {
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 0, location: 'nyc' })).toBe(true)
    expect(isGhostTelemetryEvent('run.aborted', { providerCount: 0, location: 'lax' })).toBe(true)
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 0, location: 'chi' })).toBe(true)
  })

  it('normalizes location case and surrounding whitespace', () => {
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 0, location: '  LAX  ' })).toBe(true)
    expect(isGhostTelemetryEvent('run.aborted', { providerCount: 0, location: 'NyC' })).toBe(true)
  })

  it('keeps real runs: any provider, an unknown location, or a non-run event', () => {
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 1, location: 'nyc' })).toBe(false)
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 0, location: 'sfo' })).toBe(false)
    expect(isGhostTelemetryEvent('cli.init', { providerCount: 0, location: 'nyc' })).toBe(false)
  })

  it('treats missing properties or a missing location as a real event', () => {
    expect(isGhostTelemetryEvent('run.completed')).toBe(false)
    expect(isGhostTelemetryEvent('run.completed', null)).toBe(false)
    expect(isGhostTelemetryEvent('run.completed', {})).toBe(false)
    expect(isGhostTelemetryEvent('run.completed', { providerCount: 0 })).toBe(false)
  })

  it('requires providerCount to be exactly 0, not merely falsy', () => {
    expect(isGhostTelemetryEvent('run.completed', { providerCount: undefined, location: 'nyc' })).toBe(false)
    expect(isGhostTelemetryEvent('run.completed', { providerCount: '0', location: 'nyc' })).toBe(false)
  })
})

describe('onboardingTelemetryEventSchema', () => {
  const eventId = '30ed4717-c740-433f-9d37-05421e3f1a75'
  const onboardingSessionId = '02db91c9-98d6-4826-b2cf-a9d4bec84768'

  it('accepts an allowlisted, versioned milestone', () => {
    expect(onboardingTelemetryEventSchema.parse({
      event: 'onboarding.step_completed',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      step: 'queries',
      method: 'generated',
      countBucket: '4-5',
    })).toEqual({
      event: 'onboarding.step_completed',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      step: 'queries',
      method: 'generated',
      countBucket: '4-5',
    })
  })

  it('rejects raw user content and unrecognized reason codes', () => {
    expect(onboardingTelemetryEventSchema.safeParse({
      event: 'onboarding.blocked',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      step: 'run',
      action: 'launch_run',
      reasonCode: 'sk-live-secret',
      domain: 'customer.example',
      error: 'raw provider response',
    }).success).toBe(false)
  })

  it('carries the surface that produced the event, and treats absence as the wizard', () => {
    const platform = onboardingTelemetryEventSchema.parse({
      event: 'onboarding.started',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      surface: 'platform',
      step: 'project',
      resumed: false,
    })
    expect(platform).toMatchObject({ surface: 'platform' })

    // An older client that never heard of `surface` must stay VALID: making the
    // field required would have been a breaking change to the request schema.
    // The historical default is applied at collection, not at parse.
    const legacy = onboardingTelemetryEventSchema.parse({
      event: 'onboarding.started',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      step: 'project',
      resumed: false,
    })
    expect(legacy.surface).toBeUndefined()
    expect(normalizeOnboardingEventForCollection(legacy)).toMatchObject({ surface: 'wizard' })

    expect(onboardingTelemetryEventSchema.safeParse({
      event: 'onboarding.started',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      surface: 'dashboard',
      step: 'project',
      resumed: false,
    }).success).toBe(false)
  })

  it('separates a site-health crawl from a misconfigured visibility sweep', () => {
    // Both carry zero providers and zero queries. Only `kind` says which zero
    // is correct and which is a broken setup.
    expect(onboardingTelemetryEventSchema.parse({
      event: 'run.requested',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      surface: 'platform',
      origin: 'dashboard_setup',
      result: 'queued',
      kind: 'site_health',
      providerCountBucket: '0',
      queryCountBucket: '0',
    })).toMatchObject({ kind: 'site_health' })

    expect(onboardingTelemetryEventSchema.safeParse({
      event: 'run.requested',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      origin: 'dashboard_setup',
      result: 'queued',
      kind: 'gsc_sync',
      providerCountBucket: '0',
      queryCountBucket: '0',
    }).success).toBe(false)

    // An event from before `kind` existed was an answer-visibility sweep, and
    // collection says so rather than storing a null the reader must interpret.
    const legacyRun = onboardingTelemetryEventSchema.parse({
      event: 'run.requested',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      origin: 'dashboard_setup',
      result: 'queued',
      providerCountBucket: '2-3',
      queryCountBucket: '6-10',
    })
    expect(normalizeOnboardingEventForCollection(legacyRun))
      .toMatchObject({ kind: 'answer_visibility', surface: 'wizard' })

    // Normalizing never overwrites what the client actually said.
    expect(normalizeOnboardingEventForCollection(onboardingTelemetryEventSchema.parse({
      event: 'run.requested',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      surface: 'platform',
      origin: 'dashboard_setup',
      result: 'queued',
      kind: 'site_health',
      providerCountBucket: '0',
      queryCountBucket: '0',
    }))).toMatchObject({ kind: 'site_health', surface: 'platform' })
  })

  it('accepts the provider-side block reasons the queries step actually hits', () => {
    for (const reasonCode of ['rate_limited', 'provider_auth', 'network'] as const) {
      expect(onboardingTelemetryEventSchema.safeParse({
        event: 'onboarding.blocked',
        eventId,
        flowVersion: 1,
        onboardingSessionId,
        step: 'queries',
        action: 'generate_queries',
        reasonCode,
      }).success).toBe(true)
    }
  })

  it('rejects unknown flow versions', () => {
    expect(onboardingTelemetryEventSchema.safeParse({
      event: 'onboarding.started',
      eventId,
      flowVersion: 2,
      onboardingSessionId,
      step: 'system',
      resumed: false,
    }).success).toBe(false)
  })
})

describe('bucketOnboardingCount', () => {
  it('coarsens counts without exposing exact large baskets', () => {
    expect(bucketOnboardingCount(0)).toBe('0')
    expect(bucketOnboardingCount(1)).toBe('1')
    expect(bucketOnboardingCount(3)).toBe('2-3')
    expect(bucketOnboardingCount(5)).toBe('4-5')
    expect(bucketOnboardingCount(10)).toBe('6-10')
    expect(bucketOnboardingCount(11)).toBe('11+')
  })
})

describe('telemetryStatusDtoSchema', () => {
  it.each([true, false])('normalizes legacy enabled=%s without exposing the install ID', enabled => {
    expect(normalizeTelemetryStatus({ enabled, anonymousId: '01234567-89ab-4cde-8fab-0123456789ab' })).toEqual({
      enabled, configuredEnabled: enabled, reason: enabled ? 'enabled' : 'configured_disabled',
      target: 'server', anonymousId: '01234567...',
    })
  })

  it('retains explicit effective state and masks IDs without widening the DTO', () => {
    const status = {
      enabled: false, configuredEnabled: true, reason: 'DO_NOT_TRACK' as const,
      anonymousId: '01234567...', secret: 'must-not-leak',
    }
    expect(normalizeTelemetryStatus(status, 'local')).toEqual({
      enabled: false, configuredEnabled: true, reason: 'DO_NOT_TRACK', target: 'local', anonymousId: '01234567...',
    })
    expect(normalizeTelemetryStatus({ enabled: false, anonymousId: 'invalid-id' })).not.toHaveProperty('anonymousId')
  })

  it('exposes only safe effective-state metadata', () => {
    expect(telemetryStatusDtoSchema.parse({
      enabled: false,
      configuredEnabled: true,
      reason: 'DO_NOT_TRACK',
      target: 'local',
      anonymousId: '01234567...',
    })).toEqual({
      enabled: false,
      configuredEnabled: true,
      reason: 'DO_NOT_TRACK',
      target: 'local',
      anonymousId: '01234567...',
    })
  })

  it('rejects unknown reasons and unmasked identifiers', () => {
    expect(telemetryStatusDtoSchema.safeParse({
      enabled: false,
      configuredEnabled: true,
      reason: 'operator said no',
    }).success).toBe(false)
    expect(telemetryStatusDtoSchema.safeParse({
      enabled: true,
      configuredEnabled: true,
      reason: 'enabled',
      anonymousId: '01234567-89ab-4cde-8fab-0123456789ab',
    }).success).toBe(false)
  })
})
