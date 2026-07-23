import { z } from 'zod'

function dedupeStable(values: readonly string[], caseInsensitive = false): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const key = caseInsensitive ? value.toLowerCase() : value
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function normalizeMarketingHost(value: string): string | null {
  try {
    const hasScheme = value.includes('://')
    const parsed = new URL(hasScheme ? value : `https://${value}`)
    if (!hasScheme && (parsed.pathname !== '/' || parsed.search || parsed.hash)) return null
    if (parsed.username || parsed.password || parsed.port) return null
    const host = parsed.hostname.trim().toLowerCase().replace(/^www\./, '')
    if (!host || host.includes('/') || host.includes('?') || host.includes('#')) return null
    return host
  } catch {
    return null
  }
}

// `.overwrite()` preserves the string/array output type in JSON Schema, unlike
// `.transform()`. That keeps this normalization contract representable in the
// generated OpenAPI document and typed SDK.
const marketingHostSchema = z.string().trim().min(1)
  .refine(value => normalizeMarketingHost(value) !== null, {
    message: 'Marketing hosts must be valid hostnames without credentials or ports',
  })
  .overwrite(value => normalizeMarketingHost(value) ?? value)

const brandTermSchema = z.string().trim().min(1)
const ga4EventNameSchema = z.string().trim().regex(/^[a-z]\w{0,39}$/i, {
  message: 'GA4 event names must start with a letter and contain only letters, numbers, or underscores',
})

export const measurementConfigSchema = z.object({
  marketingHosts: z.array(marketingHostSchema).default([])
    .overwrite(values => dedupeStable(values, true)),
  brandTerms: z.array(brandTermSchema).default([])
    .overwrite(values => dedupeStable(values, true)),
  leadEventNames: z.array(ga4EventNameSchema).default(['generate_lead'])
    .overwrite(values => dedupeStable(values)),
})

export type MeasurementConfig = z.infer<typeof measurementConfigSchema>

export const DEFAULT_MEASUREMENT_CONFIG: MeasurementConfig = Object.freeze({
  marketingHosts: [],
  brandTerms: [],
  leadEventNames: ['generate_lead'],
})

export const gaMeasurementComponentStatusSchema = z.enum(['never-synced', 'ready', 'error'])
export type GaMeasurementComponentStatus = z.infer<typeof gaMeasurementComponentStatusSchema>

export const gaLeadAttributionScopeSchema = z.enum(['landing-page', 'channel'])
export type GaLeadAttributionScope = z.infer<typeof gaLeadAttributionScopeSchema>
