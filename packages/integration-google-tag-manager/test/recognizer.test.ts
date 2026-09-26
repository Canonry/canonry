import { describe, expect, it } from 'vitest'
import { recognizeGoogleAdsConversionTag } from '../src/index.js'
import type { GtmCondition, GtmTag, GtmTrigger } from '../src/index.js'

function condition(type: string, left: string, right: string): GtmCondition {
  return {
    type,
    parameter: [
      { key: 'arg0', type: 'template', value: left },
      { key: 'arg1', type: 'template', value: right },
    ],
  }
}

const conversionTag: GtmTag = {
  tagId: '17',
  name: 'Google Ads - Begin checkout',
  type: 'awct',
  firingTriggerId: ['8'],
  parameter: [
    { key: 'conversionId', type: 'template', value: 'AW-12345678901' },
    { key: 'conversionLabel', type: 'template', value: 'begin_checkout_label' },
    { key: 'conversionValue', type: 'template', value: '{{DLV - ecommerce.value}}' },
    { key: 'orderId', type: 'template', value: '{{DLV - checkout_id}}' },
    { key: 'currencyCode', type: 'template', value: 'USD' },
  ],
}

const customEventTrigger: GtmTrigger = {
  triggerId: '8',
  name: 'CE - begin_checkout - production',
  type: 'customEvent',
  customEventFilter: [condition('equals', '{{_event}}', 'begin_checkout')],
  filter: [condition('contains', '{{Page Hostname}}', 'example.com')],
}

describe('Google Ads conversion tag recognizer', () => {
  it('passes a value-aware, transaction-aware SPA custom-event tag', () => {
    const result = recognizeGoogleAdsConversionTag(conversionTag, [customEventTrigger], {
      expectedEventName: 'begin_checkout',
      expectedHostname: 'example.com',
    })

    expect(result.recognition).toEqual({ status: 'recognized', kind: 'google-ads-conversion' })
    expect(result.review).toEqual({ status: 'pass', reasons: [] })
    expect(result.trigger).toMatchObject({
      strategy: 'custom-event',
      customEventNames: ['begin_checkout'],
      unresolvedTriggerIds: [],
      hostnameFilters: [{
        operator: 'contains',
        value: 'example.com',
        matchesExpectedHostname: true,
      }],
    })
    expect(result.conversion).toMatchObject({
      value: {
        parameterKey: 'conversionValue',
        value: '{{DLV - ecommerce.value}}',
        source: 'variable',
      },
      transactionId: {
        parameterKey: 'orderId',
        value: '{{DLV - checkout_id}}',
        source: 'variable',
      },
      currency: { value: 'USD', source: 'literal' },
    })
  })

  it('flags a URL trigger as unsafe for an SPA dataLayer event', () => {
    const urlTrigger: GtmTrigger = {
      triggerId: '8',
      name: 'Booking URL',
      type: 'init',
      filter: [condition('contains', '{{Page Path}}', '/booking')],
    }
    const result = recognizeGoogleAdsConversionTag(conversionTag, [urlTrigger], {
      expectedEventName: 'begin_checkout',
      expectedHostname: 'example.com',
    })

    expect(result.trigger.strategy).toBe('url-based')
    expect(result.review.status).toBe('needs-review')
    expect(result.review.reasons).toEqual(expect.arrayContaining([
      'url-based-trigger',
      'missing-hostname-filter',
    ]))
  })

  it('distinguishes a wrong hostname filter from a missing one', () => {
    const wrongHostTrigger: GtmTrigger = {
      ...customEventTrigger,
      filter: [condition('equals', '{{Page Hostname}}', 'preview.example.com')],
    }
    const result = recognizeGoogleAdsConversionTag(conversionTag, [wrongHostTrigger], {
      expectedEventName: 'begin_checkout',
      expectedHostname: 'example.com',
    })

    expect(result.trigger.hostnameFilters[0]).toMatchObject({
      value: 'preview.example.com',
      matchesExpectedHostname: false,
    })
    expect(result.review.reasons).toContain('unexpected-hostname-filter')
    expect(result.review.reasons).not.toContain('missing-hostname-filter')
  })

  it('requires value and transaction mappings on an otherwise recognized tag', () => {
    const bareTag: GtmTag = {
      ...conversionTag,
      parameter: conversionTag.parameter?.filter((parameter) =>
        parameter.key !== 'conversionValue' && parameter.key !== 'orderId'),
    }
    const result = recognizeGoogleAdsConversionTag(bareTag, [customEventTrigger], {
      expectedEventName: 'begin_checkout',
      expectedHostname: 'example.com',
    })

    expect(result.recognition.status).toBe('recognized')
    expect(result.conversion).toMatchObject({ value: null, transactionId: null })
    expect(result.review).toEqual({
      status: 'needs-review',
      reasons: ['missing-conversion-value', 'missing-transaction-id'],
    })
  })

  it.each([
    ['html', 'custom-html'],
    ['cvt_abc123', 'custom-template'],
    ['gaawc', 'unsupported-tag-type'],
  ])('keeps opaque tag type %s explicitly unknown', (type, reason) => {
    const result = recognizeGoogleAdsConversionTag({ ...conversionTag, type }, [customEventTrigger])

    expect(result.recognition).toEqual({ status: 'unknown', reason })
    expect(result.review).toEqual({ status: 'needs-review', reasons: ['tag-unknown'] })
    expect(result.conversion).toBeNull()
  })
})
