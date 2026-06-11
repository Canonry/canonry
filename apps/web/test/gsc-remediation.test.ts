import { describe, expect, test } from 'vitest'

import { gscActionNeededFromError } from '../src/lib/gsc-remediation.js'
import type { ApiErrorInfo } from '../src/lib/extract-error-message.js'

describe('gscActionNeededFromError', () => {
  const disabled: ApiErrorInfo = {
    message: 'the Google Search Console API is not enabled…',
    code: 'FORBIDDEN',
    details: {
      reason: 'gsc-api-disabled',
      projectNumber: '729411988784',
      enableUrl: 'https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=729411988784',
      indexingApiUrl: 'https://console.developers.google.com/apis/api/indexing.googleapis.com/overview?project=729411988784',
    },
  }

  test('builds a remediation card from the gsc-api-disabled FORBIDDEN', () => {
    const card = gscActionNeededFromError(disabled)
    expect(card).not.toBeNull()
    expect(card!.title).toBe('Enable the Search Console API')
    expect(card!.message).toContain('729411988784')
    expect(card!.enableUrl).toBe(disabled.details!.enableUrl)
    expect(card!.indexingApiUrl).toBe(disabled.details!.indexingApiUrl)
    expect(card!.projectNumber).toBe('729411988784')
  })

  test('omits the project number from the message when not parsed', () => {
    const card = gscActionNeededFromError({
      ...disabled,
      details: { reason: 'gsc-api-disabled' },
    })
    expect(card).not.toBeNull()
    expect(card!.projectNumber).toBeUndefined()
    expect(card!.message).not.toMatch(/\(\s*\)/) // no empty "()" left behind
    expect(card!.enableUrl).toBeUndefined()
  })

  test('returns null for the other GSC FORBIDDEN reasons (plain inline error instead)', () => {
    expect(gscActionNeededFromError({ message: 'reconnect', code: 'FORBIDDEN', details: { reason: 'gsc-reconnect' } })).toBeNull()
    expect(
      gscActionNeededFromError({ message: 'no access', code: 'FORBIDDEN', details: { reason: 'gsc-no-property-access' } }),
    ).toBeNull()
  })

  test('returns null for a non-FORBIDDEN error', () => {
    expect(gscActionNeededFromError({ message: 'boom', code: 'PROVIDER_ERROR', details: { reason: 'gsc-api-disabled' } })).toBeNull()
  })

  test('returns null when there are no details', () => {
    expect(gscActionNeededFromError({ message: 'boom', code: 'FORBIDDEN' })).toBeNull()
  })
})
