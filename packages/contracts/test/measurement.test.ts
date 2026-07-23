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
  it('defaults to the recommended GA4 lead event without inventing host or brand overrides', () => {
    expect(measurementConfigSchema).toBeDefined()
    expect(measurementConfigSchema.parse({})).toEqual(EXPECTED_DEFAULT)
    expect(DEFAULT_MEASUREMENT_CONFIG).toEqual(EXPECTED_DEFAULT)
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
