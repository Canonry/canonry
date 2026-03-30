export interface BusinessAddress {
  street?: string
  city?: string
  state?: string
  zip?: string
  country?: string
}

export interface BusinessProfile {
  name: string
  url?: string
  description?: string
  phone?: string
  email?: string
  address?: BusinessAddress
}

export interface FaqEntry {
  q: string
  a: string
}

export type SchemaPageEntry =
  | string
  | { type: string; faqs?: FaqEntry[] }

export interface SchemaProfileFile {
  business: BusinessProfile
  pages: Record<string, SchemaPageEntry[]>
}

const SUPPORTED_TYPES = new Set([
  'LocalBusiness',
  'Organization',
  'FAQPage',
  'Service',
  'WebPage',
])

export function isSupportedSchemaType(type: string): boolean {
  return SUPPORTED_TYPES.has(type)
}

export function supportedSchemaTypes(): string[] {
  return [...SUPPORTED_TYPES]
}

function buildAddress(address: BusinessAddress): Record<string, unknown> {
  return {
    '@type': 'PostalAddress',
    ...(address.street ? { streetAddress: address.street } : {}),
    ...(address.city ? { addressLocality: address.city } : {}),
    ...(address.state ? { addressRegion: address.state } : {}),
    ...(address.zip ? { postalCode: address.zip } : {}),
    ...(address.country ? { addressCountry: address.country } : {}),
  }
}

function generateLocalBusiness(profile: BusinessProfile): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: profile.name,
  }
  if (profile.url) schema.url = profile.url
  if (profile.description) schema.description = profile.description
  if (profile.phone) schema.telephone = profile.phone
  if (profile.email) schema.email = profile.email
  if (profile.address) schema.address = buildAddress(profile.address)
  return schema
}

function generateOrganization(profile: BusinessProfile): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: profile.name,
  }
  if (profile.url) schema.url = profile.url
  if (profile.description) schema.description = profile.description
  if (profile.phone) schema.telephone = profile.phone
  if (profile.email) schema.email = profile.email
  if (profile.address) schema.address = buildAddress(profile.address)
  return schema
}

function generateFAQPage(profile: BusinessProfile, faqs?: FaqEntry[]): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    name: profile.name,
  }
  if (faqs && faqs.length > 0) {
    schema.mainEntity = faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.a,
      },
    }))
  }
  return schema
}

function generateService(profile: BusinessProfile): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: profile.name,
  }
  if (profile.url) schema.url = profile.url
  if (profile.description) schema.description = profile.description
  if (profile.address) schema.areaServed = buildAddress(profile.address)
  return schema
}

function generateWebPage(profile: BusinessProfile): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: profile.name,
  }
  if (profile.url) schema.url = profile.url
  if (profile.description) schema.description = profile.description
  return schema
}

export function generateSchema(
  type: string,
  profile: BusinessProfile,
  overrides?: { faqs?: FaqEntry[] },
): Record<string, unknown> {
  switch (type) {
    case 'LocalBusiness': return generateLocalBusiness(profile)
    case 'Organization': return generateOrganization(profile)
    case 'FAQPage': return generateFAQPage(profile, overrides?.faqs)
    case 'Service': return generateService(profile)
    case 'WebPage': return generateWebPage(profile)
    default: throw new Error(`Unsupported schema type: ${type}`)
  }
}

export function parseSchemaPageEntry(entry: SchemaPageEntry): { type: string; faqs?: FaqEntry[] } {
  if (typeof entry === 'string') {
    return { type: entry }
  }
  return { type: entry.type, faqs: entry.faqs }
}
