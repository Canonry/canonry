import { describe, expect, it } from 'vitest'
import {
  generateSchema,
  isSupportedSchemaType,
  parseSchemaPageEntry,
  supportedSchemaTypes,
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

  describe('supportedSchemaTypes', () => {
    it('returns list of supported types', () => {
      const types = supportedSchemaTypes()
      expect(types).toEqual([
        'LocalBusiness',
        'Organization',
        'FAQPage',
        'Service',
        'WebPage',
      ])
    })
  })

  describe('parseSchemaPageEntry', () => {
    it('parses string entry', () => {
      const result = parseSchemaPageEntry('LocalBusiness')
      expect(result).toEqual({ type: 'LocalBusiness' })
    })

    it('parses object entry with type only', () => {
      const result = parseSchemaPageEntry({ type: 'Organization' })
      expect(result).toEqual({ type: 'Organization' })
    })

    it('parses object entry with type and faqs', () => {
      const faqs = [
        { q: 'Question 1', a: 'Answer 1' },
        { q: 'Question 2', a: 'Answer 2' },
      ]
      const result = parseSchemaPageEntry({ type: 'FAQPage', faqs })
      expect(result).toEqual({ type: 'FAQPage', faqs })
    })
  })

  describe('generateSchema', () => {
    it('generates LocalBusiness schema', () => {
      const schema = generateSchema('LocalBusiness', mockBusiness)
      expect(schema['@type']).toBe('LocalBusiness')
      expect(schema.name).toBe(mockBusiness.name)
      expect(schema.url).toBe(mockBusiness.url)
      expect(schema.description).toBe(mockBusiness.description)
      expect(schema.telephone).toBe(mockBusiness.phone)
      expect(schema.email).toBe(mockBusiness.email)
      expect(schema.address).toEqual({
        '@type': 'PostalAddress',
        streetAddress: mockBusiness.address!.street,
        addressLocality: mockBusiness.address!.city,
        addressRegion: mockBusiness.address!.state,
        postalCode: mockBusiness.address!.zip,
        addressCountry: mockBusiness.address!.country,
      })
    })

    it('generates Organization schema', () => {
      const schema = generateSchema('Organization', mockBusiness)
      expect(schema['@type']).toBe('Organization')
      expect(schema.name).toBe(mockBusiness.name)
      expect(schema.url).toBe(mockBusiness.url)
      expect(schema.description).toBe(mockBusiness.description)
      expect(schema.telephone).toBe(mockBusiness.phone)
      expect(schema.email).toBe(mockBusiness.email)
      expect(schema.address).toEqual({
        '@type': 'PostalAddress',
        streetAddress: mockBusiness.address!.street,
        addressLocality: mockBusiness.address!.city,
        addressRegion: mockBusiness.address!.state,
        postalCode: mockBusiness.address!.zip,
        addressCountry: mockBusiness.address!.country,
      })
    })

    it('generates FAQPage schema with faqs', () => {
      const faqs = [
        { q: 'Question 1', a: 'Answer 1' },
        { q: 'Question 2', a: 'Answer 2' },
      ]
      const schema = generateSchema('FAQPage', mockBusiness, { faqs })
      expect(schema['@type']).toBe('FAQPage')
      expect(schema.name).toBe(mockBusiness.name)
      expect(schema.mainEntity).toEqual([
        {
          '@type': 'Question',
          name: 'Question 1',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Answer 1',
          },
        },
        {
          '@type': 'Question',
          name: 'Question 2',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Answer 2',
          },
        },
      ])
    })

    it('generates FAQPage schema without faqs', () => {
      const schema = generateSchema('FAQPage', mockBusiness)
      expect(schema['@type']).toBe('FAQPage')
      expect(schema.name).toBe(mockBusiness.name)
      expect(schema.mainEntity).toBeUndefined()
    })

    it('generates Service schema', () => {
      const schema = generateSchema('Service', mockBusiness)
      expect(schema['@type']).toBe('Service')
      expect(schema.name).toBe(mockBusiness.name)
      expect(schema.url).toBe(mockBusiness.url)
      expect(schema.description).toBe(mockBusiness.description)
      expect(schema.areaServed).toEqual({
        '@type': 'PostalAddress',
        streetAddress: mockBusiness.address!.street,
        addressLocality: mockBusiness.address!.city,
        addressRegion: mockBusiness.address!.state,
        postalCode: mockBusiness.address!.zip,
        addressCountry: mockBusiness.address!.country,
      })
    })

    it('generates WebPage schema', () => {
      const schema = generateSchema('WebPage', mockBusiness)
      expect(schema['@type']).toBe('WebPage')
      expect(schema.name).toBe(mockBusiness.name)
      expect(schema.url).toBe(mockBusiness.url)
      expect(schema.description).toBe(mockBusiness.description)
    })

    it('throws error for unsupported type', () => {
      expect(() => generateSchema('InvalidType', mockBusiness)).toThrow('Unsupported schema type')
    })
  })
})