import { describe, expect, it } from 'vitest'
import { GOOGLE_ADS_API_HOST } from '../../integration-google-ads/src/constants.js'
import { GTM_API_BASE } from '../../integration-google-tag-manager/src/constants.js'
import { OPENAI_ADS_API_BASE } from '../../integration-openai-ads/src/constants.js'

import { API_HOST_TABLE as table } from '../../api-routes/src/doctor/checks/api-hosts.js'

describe('provider API host table', () => {
  it('matches the integration base host constants', () => {
    expect(table['google-ads'][0]).toBe(new URL(GOOGLE_ADS_API_HOST).hostname)
    expect(table.gtm[0]).toBe(new URL(GTM_API_BASE).hostname)
    expect(table.ads[0]).toBe(new URL(OPENAI_ADS_API_BASE).hostname)
    expect(table['google-ads'][1]).toBe('oauth2.googleapis.com')
    expect(table.gtm[1]).toBe('oauth2.googleapis.com')
  })
})
