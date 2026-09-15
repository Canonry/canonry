import { describe, expect, it } from 'vitest'
import { parseVisibilityReportScopeErrorDetails } from '@ainyc/canonry-contracts'
import { ApiError, apiErrorDetails } from '../src/api.js'

const retiredMarket = { reason: 'retired-market', kind: 'market', key: 'coastal-maine' }

describe('apiErrorDetails', () => {
  it('returns the details an ApiError carries', () => {
    expect(apiErrorDetails(new ApiError('Market "coastal-maine" is not in this frozen definition.', 400, 'VALIDATION_ERROR', retiredMarket))).toBe(retiredMarket)
    expect(apiErrorDetails(new ApiError('Synthetic failure', 500, 'INTERNAL_ERROR'))).toBeUndefined()
  })

  it('reads details from the envelope a generated query throws', () => {
    const thrown = { error: { code: 'VALIDATION_ERROR', message: 'Market "coastal-maine" is not in this frozen definition.', details: retiredMarket } }
    expect(apiErrorDetails(thrown)).toBe(retiredMarket)
    expect(parseVisibilityReportScopeErrorDetails(apiErrorDetails(thrown))).toEqual({ reason: 'retired-market', kind: 'market', key: 'coastal-maine' })
  })

  it('reads details from a flat error body', () => {
    expect(apiErrorDetails({ code: 'VALIDATION_ERROR', message: 'Market "coastal-maine" is not in this frozen definition.', details: retiredMarket })).toBe(retiredMarket)
  })

  it('returns nothing for a string, a body without details, or details that are not an object', () => {
    expect(apiErrorDetails('Market "coastal-maine" is not in this frozen definition.')).toBeUndefined()
    expect(apiErrorDetails(null)).toBeUndefined()
    expect(apiErrorDetails(undefined)).toBeUndefined()
    expect(apiErrorDetails(new Error('Failed to fetch'))).toBeUndefined()
    expect(apiErrorDetails({ error: 'Synthetic failure' })).toBeUndefined()
    expect(apiErrorDetails({ error: { code: 'VALIDATION_ERROR', message: 'Synthetic failure' } })).toBeUndefined()
    expect(apiErrorDetails({ error: { code: 'VALIDATION_ERROR', message: 'Synthetic failure', details: 'retired-market' } })).toBeUndefined()
    expect(apiErrorDetails({ error: { code: 'VALIDATION_ERROR', message: 'Synthetic failure', details: [retiredMarket] } })).toBeUndefined()
    expect(apiErrorDetails({ code: 'VALIDATION_ERROR', message: 'Synthetic failure', details: null })).toBeUndefined()
  })

  it('leaves the meaning of details to the typed parser', () => {
    const disabledApi = { reason: 'gsc-api-disabled', enableUrl: 'https://console.cloud.google.com/apis/library', projectNumber: '123' }
    const thrown = { error: { code: 'FORBIDDEN', message: 'Search Console API is disabled.', details: disabledApi } }
    expect(apiErrorDetails(thrown)).toBe(disabledApi)
    expect(parseVisibilityReportScopeErrorDetails(apiErrorDetails(thrown))).toBeUndefined()
  })
})
