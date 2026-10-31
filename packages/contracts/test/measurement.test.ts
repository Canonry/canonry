import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEASUREMENT_CONFIG,
  NON_CONVERSION_KEY_EVENTS,
  countedLeadEventNames,
  ignoredKeyEventNames,
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
    const input = { marketingHosts: ['example.com'], brandTerms: ['Example'], leadEventNames: ['generate_lead'] }
    expect(measurementConfigSchema.parse(input)).toEqual(input)
    for (const [invalid, expectedPath] of [
      [{ ...input, marketingHosts: ['example.com/pricing'] }, ['marketingHosts', 0]],
      [{ ...input, leadEventNames: ['generate-lead'] }, ['leadEventNames', 0]],
    ] as const) {
      const result = measurementConfigSchema.safeParse(invalid)
      expect(result.success).toBe(false)
      expect(result.error?.issues.map(issue => issue.path)).toEqual([expectedPath])
    }
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

describe('counted GA4 conversion events', () => {
  it('counts configured lead events plus key events that are outcomes, not funnel or engagement steps', () => {
    expect(countedLeadEventNames(['generate_lead'], ['add_to_cart', 'purchase', 'view_item', 'page_view', 'sign_up']))
      .toEqual(['generate_lead', 'purchase', 'sign_up'])
    expect(ignoredKeyEventNames(['generate_lead'], ['add_to_cart', 'purchase', 'view_item', 'page_view', 'sign_up']))
      .toEqual(['add_to_cart', 'page_view', 'view_item'])
  })

  it('always counts a configured lead event, even a funnel step', () => {
    expect(countedLeadEventNames(['begin_checkout'], ['begin_checkout', 'purchase'])).toEqual(['begin_checkout', 'purchase'])
    expect(ignoredKeyEventNames(['begin_checkout'], ['begin_checkout', 'purchase'])).toEqual([])
  })

  it('lists only standard GA4 event names, so the rule is the same for every property', () => {
    for (const name of NON_CONVERSION_KEY_EVENTS) expect(name).toMatch(/^[a-z]+(?:_[a-z]+)*$/)
    expect(NON_CONVERSION_KEY_EVENTS).not.toContain('purchase')
    expect(NON_CONVERSION_KEY_EVENTS).not.toContain('generate_lead')
  })
})
