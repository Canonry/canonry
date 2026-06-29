import { describe, expect, it } from 'vitest'
import { isGhostTelemetryEvent } from '../src/telemetry.js'

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
