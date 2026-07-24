import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEASUREMENT_CONFIG,
  measurementConfigSchema,
  projectConfigSchema,
  projectDtoSchema,
  projectUpsertRequestSchema,
} from '../src/index.js'

const EXPECTED_DEFAULT = {
  marketingHosts: [],
  brandTerms: [],
  leadEventNames: ['generate_lead'],
}

describe('measurementConfigSchema', () => {
  it('keeps defaults at the outer project boundary and rejects partial measurement objects', () => {
    expect(measurementConfigSchema).toBeDefined()
    expect(() => measurementConfigSchema.parse({})).toThrow()
    expect(() => measurementConfigSchema.parse({
      marketingHosts: ['example.com'],
    })).toThrow()
    expect(DEFAULT_MEASUREMENT_CONFIG).toEqual(EXPECTED_DEFAULT)
  })

  it('deep-freezes the exported default and gives every omitted project fresh arrays', () => {
    expect(Object.isFrozen(DEFAULT_MEASUREMENT_CONFIG)).toBe(true)
    expect(Object.isFrozen(DEFAULT_MEASUREMENT_CONFIG.marketingHosts)).toBe(true)
    expect(Object.isFrozen(DEFAULT_MEASUREMENT_CONFIG.brandTerms)).toBe(true)
    expect(Object.isFrozen(DEFAULT_MEASUREMENT_CONFIG.leadEventNames)).toBe(true)

    const first = projectDtoSchema.parse({
      id: 'project_1', name: 'one', canonicalDomain: 'example.com', country: 'US', language: 'en',
    })
    const second = projectDtoSchema.parse({
      id: 'project_2', name: 'two', canonicalDomain: 'example.org', country: 'US', language: 'en',
    })
    expect(first.measurement).not.toBe(second.measurement)
    expect(first.measurement.marketingHosts).not.toBe(second.measurement.marketingHosts)
    expect(first.measurement.brandTerms).not.toBe(second.measurement.brandTerms)
    expect(first.measurement.leadEventNames).not.toBe(second.measurement.leadEventNames)
  })

  it('normalizes hosts and trims/deduplicates operator-supplied terms', () => {
    expect(measurementConfigSchema.parse({
      marketingHosts: [
        ' HTTPS://WWW.Example.com/path ',
        'example.com',
        'Blog.Example.com',
      ],
      brandTerms: [' Example Solar ', 'example solar', 'Solar Quote'],
      leadEventNames: ['generate_lead', 'book_demo', 'book_demo'],
    })).toEqual({
      marketingHosts: ['example.com', 'blog.example.com'],
      brandTerms: ['Example Solar', 'Solar Quote'],
      leadEventNames: ['generate_lead', 'book_demo'],
    })
  })

  it('rejects path-like hosts and invalid GA4 event names', () => {
    expect(measurementConfigSchema).toBeDefined()
    expect(() => measurementConfigSchema.parse({
      marketingHosts: ['example.com/pricing'],
    })).toThrow()
    expect(() => measurementConfigSchema.parse({
      leadEventNames: ['generate-lead'],
    })).toThrow()
  })
})

describe('project measurement contract', () => {
  it('defaults old project DTOs without erasing the distinction between defaults and explicit overrides', () => {
    const project = projectDtoSchema.parse({
      id: 'project_1',
      name: 'example',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
    expect(project.measurement).toEqual(DEFAULT_MEASUREMENT_CONFIG)
  })

  it('accepts measurement config through both API upserts and config-as-code', () => {
    const measurement = {
      marketingHosts: ['offers.example.com'],
      brandTerms: ['Example Pro'],
      leadEventNames: ['generate_lead', 'book_demo'],
    }

    expect(projectUpsertRequestSchema.parse({
      displayName: 'Example',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      measurement,
    }).measurement).toEqual(measurement)

    const config = projectConfigSchema.parse({
      apiVersion: 'canonry/v1',
      kind: 'Project',
      metadata: { name: 'example' },
      spec: {
        displayName: 'Example',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        measurement,
      },
    })
    expect(config.spec.measurement).toEqual(measurement)
  })
})
