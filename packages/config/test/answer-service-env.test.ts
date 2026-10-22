import { describe, expect, it } from 'vitest'
import { getAnswerServiceEnv } from '../src/index.js'

const services = [
  { id: 'acme-answers', settings: { fields: [{ key: 'apiKey' as const, env: 'ACME_ANSWERS_API_KEY' }] } },
  { id: 'other-answers', settings: { fields: [{ key: 'apiKey' as const, env: 'OTHER_ANSWERS_API_KEY' }] } },
  { id: 'config-only', settings: { fields: [{ key: 'apiKey' as const, env: null }] } },
]

describe('answer service env bootstrap', () => {
  it('reads each declared key variable, trimmed, and creates no entry for an unset or blank one', () => {
    expect(getAnswerServiceEnv({ ACME_ANSWERS_API_KEY: '  key-1  ', OTHER_ANSWERS_API_KEY: '   ', CONFIG_ONLY_API_KEY: 'ignored' }, services))
      .toEqual({ 'acme-answers': { apiKey: 'key-1' } })
  })

  it('returns nothing when no service is registered', () => {
    expect(getAnswerServiceEnv({ ACME_ANSWERS_API_KEY: 'key-1' }, [])).toEqual({})
  })
})
