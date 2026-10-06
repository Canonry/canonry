import { describe, expect, it } from 'vitest'
import {
  generateSchema,
  isSupportedSchemaType,
  type BusinessProfile,
} from '../src/schema-templates.js'

describe('schema-templates', () => {
  const mockBusiness: BusinessProfile = {
    name: 'Test Business',
    url: 'https://example.com',
    description: 'A test business',
    phone: '+1234567890',
    email: 'info@example.com',
    address: {
      street: '123 Main St',
      city: 'Anytown',
      state: 'CA',
      zip: '90210',
      country: 'USA',
    },
  }

  describe('isSupportedSchemaType', () => {
    it('returns true for supported types', () => {
      expect(isSupportedSchemaType('LocalBusiness')).toBe(true)
      expect(isSupportedSchemaType('Organization')).toBe(true)
      expect(isSupportedSchemaType('FAQPage')).toBe(true)
      expect(isSupportedSchemaType('Service')).toBe(true)
      expect(isSupportedSchemaType('WebPage')).toBe(true)
    })

    it('returns false for unsupported types', () => {
      expect(isSupportedSchemaType('Product')).toBe(false)
      expect(isSupportedSchemaType('Person')).toBe(false)
      expect(isSupportedSchemaType('')).toBe(false)
    })
  })

  describe('generateSchema', () => {
    it('generates LocalBusiness schema', () => {
      expect(generateSchema('LocalBusiness', mockBusiness)).toEqual({
        '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Test Business',
        url: 'https://example.com', description: 'A test business',
        telephone: '+1234567890', email: 'info@example.com',
        address: {
          '@type': 'PostalAddress', streetAddress: '123 Main St', addressLocality: 'Anytown',
          addressRegion: 'CA', postalCode: '90210', addressCountry: 'USA',
        },
      })
    })

    it('generates Organization schema', () => {
      expect(generateSchema('Organization', mockBusiness)).toEqual({
        '@context': 'https://schema.org', '@type': 'Organization', name: 'Test Business',
        url: 'https://example.com', description: 'A test business',
        telephone: '+1234567890', email: 'info@example.com',
        address: {
          '@type': 'PostalAddress', streetAddress: '123 Main St', addressLocality: 'Anytown',
          addressRegion: 'CA', postalCode: '90210', addressCountry: 'USA',
        },
      })
      expect(generateSchema('Organization', { name: 'Minimal Co' })).toEqual({
        '@context': 'https://schema.org', '@type': 'Organization', name: 'Minimal Co',
      })
    })

    it('generates FAQPage schema with faqs', () => {
      const faqs = [
        { q: 'Question 1', a: 'Answer 1' },
        { q: 'Question 2', a: 'Answer 2' },
      ]
      expect(generateSchema('FAQPage', mockBusiness, { faqs })).toEqual({
        '@context': 'https://schema.org', '@type': 'FAQPage', name: 'Test Business',
        mainEntity: [
          { '@type': 'Question', name: 'Question 1', acceptedAnswer: { '@type': 'Answer', text: 'Answer 1' } },
          { '@type': 'Question', name: 'Question 2', acceptedAnswer: { '@type': 'Answer', text: 'Answer 2' } },
        ],
      })
    })

    it('generates FAQPage schema without faqs', () => {
      const schema = generateSchema('FAQPage', mockBusiness)
      expect(schema['@type']).toBe('FAQPage')
      expect(schema.name).toBe(mockBusiness.name)
      expect(schema.mainEntity).toBeUndefined()
    })

    it('generates Service schema', () => {
      expect(generateSchema('Service', mockBusiness)).toEqual({
        '@context': 'https://schema.org', '@type': 'Service', name: 'Test Business',
        url: 'https://example.com', description: 'A test business',
        areaServed: {
          '@type': 'PostalAddress', streetAddress: '123 Main St', addressLocality: 'Anytown',
          addressRegion: 'CA', postalCode: '90210', addressCountry: 'USA',
        },
      })
    })

    it('generates WebPage schema', () => {
      expect(generateSchema('WebPage', mockBusiness)).toEqual({
        '@context': 'https://schema.org', '@type': 'WebPage', name: 'Test Business',
        url: 'https://example.com', description: 'A test business',
      })
    })

    it('throws error for unsupported type', () => {
      expect(() => generateSchema('InvalidType', mockBusiness)).toThrow('Unsupported schema type')
    })
  })
})
