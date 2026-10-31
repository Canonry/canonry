import { test } from 'vitest'
import { loadValTownConfig } from '../src/config/index.js'
import { HumanVerificationError } from '../src/security/turnstile.js'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

test('production fails closed when quota salt is absent', () => {
  const config = loadValTownConfig({
    VAL_TOWN_ENV: 'production',
    TURNSTILE_SECRET_KEY: 'secret',
    TURNSTILE_SITE_KEY: 'site-key',
    TURNSTILE_ALLOWED_HOSTNAMES: 'example.val.run',
  })
  equal(config.publicChecksEnabled, false)
  equal(config.quotaSalt, '')
  equal(config.publicChecksUnavailableMessage, 'Public checks are temporarily unavailable.')
})

test('production requires every Turnstile hostname/site-key/secret component', async () => {
  const complete = {
    VAL_TOWN_ENV: 'production',
    CANONRY_QUOTA_SALT: 'stable-salt',
    TURNSTILE_SECRET_KEY: 'secret',
    TURNSTILE_SITE_KEY: 'site-key',
    TURNSTILE_ALLOWED_HOSTNAMES: 'example.val.run',
  }
  const ready = loadValTownConfig(complete)
  equal(ready.humanVerificationStatus, 'ready')
  equal(ready.turnstileSiteKey, 'site-key')
  for (const field of ['TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY', 'TURNSTILE_ALLOWED_HOSTNAMES']) {
    for (const missing of [undefined, '   ']) {
      const config = loadValTownConfig({ ...complete, [field]: missing })
      equal(config.humanVerificationStatus, 'unavailable', field)
      equal(config.turnstileSiteKey, null, field)
      equal(config.publicChecksEnabled, true, field)
      let rejection: unknown
      try {
        await config.humanVerifier.verify({ token: 'token', remoteIp: null })
      } catch (error) {
        rejection = error
      }
      if (!(rejection instanceof HumanVerificationError)) throw new Error(`expected unavailable verifier for ${field}`)
      equal(rejection.code, 'unavailable', field)
      equal(rejection.message, 'Human verification is not configured.', field)
    }
  }
})

test('explicit development bypass does not become a production default', () => {
  const config = loadValTownConfig({ VAL_TOWN_ENV: 'development', ALLOW_INSECURE_LOCAL_HUMAN_BYPASS: '1' })
  equal(config.humanVerificationStatus, 'not-required')
  equal(config.publicChecksEnabled, true)
  equal(config.quotaSalt, 'local-development-only')

  const unsetEnvironment = loadValTownConfig({ ALLOW_INSECURE_LOCAL_HUMAN_BYPASS: '1' })
  equal(unsetEnvironment.environment, 'production')
  equal(unsetEnvironment.humanVerificationStatus, 'unavailable')
  equal(unsetEnvironment.publicChecksEnabled, false)
})
