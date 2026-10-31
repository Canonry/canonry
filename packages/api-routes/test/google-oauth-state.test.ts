import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildSignedGoogleOAuthState,
  verifySignedGoogleOAuthState,
} from '../src/google-oauth-state.js'

function encodeFixtureEnvelope(envelope: unknown): string {
  return Buffer.from(JSON.stringify(envelope)).toString('base64url')
}

function signFixturePayload(payload: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(payload).digest('hex')
  return encodeFixtureEnvelope({ payload, sig })
}

describe('Google OAuth state', () => {
  const secret = 'test-secret-at-least-long-enough'
  const now = 1786708800000

  it('round-trips a fresh project-bound state', () => {
    const encoded = buildSignedGoogleOAuthState({ projectId: 'project-1', integration: 'gtm' }, secret, now)
    // Independent Python hmac/base64 vector over the literal payload below.
    expect(encoded).toBe('eyJwYXlsb2FkIjoie1wicHJvamVjdElkXCI6XCJwcm9qZWN0LTFcIixcImludGVncmF0aW9uXCI6XCJndG1cIixcImlzc3VlZEF0XCI6MTc4NjcwODgwMDAwMH0iLCJzaWciOiJlNjEwZWFkMTVlYWE3MjZmYmQ1YzI1OGJjNTZhY2EyMWZiM2ZiMGIxMTk1ODQ3MWFkYjk1ZjMxODc5OWU5MWRmIn0')
    expect(verifySignedGoogleOAuthState(encoded, secret, now)).toEqual({
      projectId: 'project-1',
      integration: 'gtm',
      issuedAt: 1786708800000,
    })
  })

  it('rejects expired, future, tampered, and malformed states', () => {
    const payload = '{"projectId":"project-1","integration":"gtm","issuedAt":1786708800000}'
    const sig = 'e610ead15eaa726fbd5c258bc56aca21fb3fb0b11958471adb95f318799e91df'
    const canonical = 'eyJwYXlsb2FkIjoie1wicHJvamVjdElkXCI6XCJwcm9qZWN0LTFcIixcImludGVncmF0aW9uXCI6XCJndG1cIixcImlzc3VlZEF0XCI6MTc4NjcwODgwMDAwMH0iLCJzaWciOiJlNjEwZWFkMTVlYWE3MjZmYmQ1YzI1OGJjNTZhY2EyMWZiM2ZiMGIxMTk1ODQ3MWFkYjk1ZjMxODc5OWU5MWRmIn0'
    const alias = `${canonical.slice(0, -1)}1`
    expect(alias, 'noncanonical alias differs from canonical wire').not.toBe(canonical)
    expect(Buffer.from(alias, 'base64url'), 'noncanonical alias decodes to the same envelope bytes')
      .toEqual(Buffer.from(canonical, 'base64url'))

    const cases: Array<{
      name: string
      encoded: string
      expected: Record<string, unknown> | null
    }> = [
      {
        name: 'fresh independent signature is accepted',
        encoded: signFixturePayload(payload, secret),
        expected: { projectId: 'project-1', integration: 'gtm', issuedAt: 1786708800000 },
      },
      {
        name: 'literal 900000ms age is accepted',
        encoded: signFixturePayload('{"projectId":"project-1","integration":"gtm","issuedAt":1786707900000}', secret),
        expected: { projectId: 'project-1', integration: 'gtm', issuedAt: 1786707900000 },
      },
      {
        name: 'literal 900001ms age is expired',
        encoded: signFixturePayload('{"projectId":"project-1","integration":"gtm","issuedAt":1786707899999}', secret),
        expected: null,
      },
      {
        name: 'literal 1ms future timestamp is refused',
        encoded: signFixturePayload('{"projectId":"project-1","integration":"gtm","issuedAt":1786708800001}', secret),
        expected: null,
      },
      {
        name: 'correctly signed missing issuedAt is refused',
        encoded: signFixturePayload('{"projectId":"project-1","integration":"gtm"}', secret),
        expected: null,
      },
      {
        name: 'correctly signed string issuedAt is refused',
        encoded: signFixturePayload('{"projectId":"project-1","integration":"gtm","issuedAt":"1786708800000"}', secret),
        expected: null,
      },
      {
        name: 'otherwise valid fresh state signed by another secret is refused',
        encoded: signFixturePayload(payload, 'another-independent-secret'),
        expected: null,
      },
      {
        name: 'valid-time payload tamper with original signature is refused',
        encoded: encodeFixtureEnvelope({
          payload: '{"projectId":"project-2","integration":"gtm","issuedAt":1786708800000}',
          sig,
        }),
        expected: null,
      },
      {
        name: 'valid-time 64-lowercase-hex signature tamper is refused',
        encoded: encodeFixtureEnvelope({ payload, sig: `0${sig.slice(1)}` }),
        expected: null,
      },
      {
        name: 'empty encoding is refused',
        encoded: '',
        expected: null,
      },
      {
        name: 'illegal base64url characters are refused',
        encoded: 'not-valid-base64url!!!',
        expected: null,
      },
      {
        name: 'padded canonical bytes are refused',
        encoded: `${canonical}=`,
        expected: null,
      },
      {
        name: 'canonical base64url with malformed envelope JSON is refused',
        encoded: Buffer.from('not-envelope-json').toString('base64url'),
        expected: null,
      },
      {
        name: 'null envelope is refused',
        encoded: encodeFixtureEnvelope(null),
        expected: null,
      },
      {
        name: 'missing envelope payload is refused',
        encoded: encodeFixtureEnvelope({ sig }),
        expected: null,
      },
      {
        name: 'missing envelope signature is refused',
        encoded: encodeFixtureEnvelope({ payload }),
        expected: null,
      },
      {
        name: 'object envelope payload is refused',
        encoded: encodeFixtureEnvelope({ payload: { issuedAt: 1786708800000 }, sig }),
        expected: null,
      },
      {
        name: 'numeric envelope signature is refused',
        encoded: encodeFixtureEnvelope({ payload, sig: 123 }),
        expected: null,
      },
      {
        name: '63-hex-character signature is refused',
        encoded: encodeFixtureEnvelope({ payload, sig: sig.slice(1) }),
        expected: null,
      },
      {
        name: '65-hex-character signature is refused',
        encoded: encodeFixtureEnvelope({ payload, sig: `${sig}0` }),
        expected: null,
      },
      {
        name: 'uppercase signature alias is refused',
        encoded: encodeFixtureEnvelope({ payload, sig: sig.toUpperCase() }),
        expected: null,
      },
      {
        name: '64-character nonhex signature is refused',
        encoded: encodeFixtureEnvelope({ payload, sig: `g${sig.slice(1)}` }),
        expected: null,
      },
      {
        name: 'correctly signed malformed payload JSON is refused',
        encoded: signFixturePayload('not-payload-json', secret),
        expected: null,
      },
      {
        name: 'same-bytes noncanonical base64url alias is refused',
        encoded: alias,
        expected: null,
      },
    ]

    for (const testCase of cases) {
      expect(verifySignedGoogleOAuthState(testCase.encoded, secret, now), testCase.name)
        .toEqual(testCase.expected)
    }
  })
})
