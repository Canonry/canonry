import { describe, expect, it } from 'vitest'
import { resolveGoogleSignInConfig } from '../src/index.js'

describe('resolveGoogleSignInConfig', () => {
  it('uses stored local configuration when no environment setting is present', () => {
    expect(resolveGoogleSignInConfig({}, {
      auth: { google: { enabled: true, clientId: 'local-id', clientSecret: 'local-secret' } },
    })).toEqual({
      config: { enabled: true, clientId: 'local-id', clientSecret: 'local-secret' },
      environmentOverride: false,
    })
  })

  it('honours an explicit false environment override without discarding stored credentials', () => {
    expect(resolveGoogleSignInConfig({ CANONRY_GOOGLE_SIGN_IN_ENABLED: 'false' }, {
      auth: { google: { enabled: true, clientId: 'local-id', clientSecret: 'local-secret' } },
    })).toEqual({
      config: { enabled: false, clientId: 'local-id', clientSecret: 'local-secret' },
      environmentOverride: true,
    })
  })

  it('overrides only environment-provided values and marks the settings read-only', () => {
    expect(resolveGoogleSignInConfig({
      CANONRY_GOOGLE_SIGN_IN_ENABLED: 'yes',
      CANONRY_GOOGLE_SIGN_IN_CLIENT_ID: 'cloud-id',
    }, {
      auth: { google: { enabled: false, clientId: 'local-id', clientSecret: 'local-secret' } },
    })).toEqual({
      config: { enabled: true, clientId: 'cloud-id', clientSecret: 'local-secret' },
      environmentOverride: true,
    })
  })

  it('rejects malformed enablement rather than silently changing login behavior', () => {
    expect(() => resolveGoogleSignInConfig({ CANONRY_GOOGLE_SIGN_IN_ENABLED: 'sometimes' }))
      .toThrow('CANONRY_GOOGLE_SIGN_IN_ENABLED must be true or false')
  })
})
