import { describe, expect, it } from 'vitest'
import { createServiceAccountJwt } from '../src/ga4-client.js'
import crypto from 'node:crypto'

describe('createServiceAccountJwt', () => {
  it('produces a three-part JWT string', () => {
    // Generate a test RSA key pair
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })

    const jwt = createServiceAccountJwt(
      'test@test.iam.gserviceaccount.com',
      privateKey,
      'https://www.googleapis.com/auth/analytics.readonly',
    )

    const parts = jwt.split('.')
    expect(parts).toHaveLength(3)

    // Verify header
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString())
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })

    // Verify payload
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
    expect(payload.iss).toBe('test@test.iam.gserviceaccount.com')
    expect(payload.scope).toBe('https://www.googleapis.com/auth/analytics.readonly')
    expect(payload.aud).toBe('https://oauth2.googleapis.com/token')
    expect(payload.exp).toBe(payload.iat + 3600)
  })

  it('signature is verifiable with the corresponding public key', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })

    const jwt = createServiceAccountJwt(
      'test@test.iam.gserviceaccount.com',
      privateKey,
      'https://www.googleapis.com/auth/analytics.readonly',
    )

    const parts = jwt.split('.')
    const signingInput = `${parts[0]}.${parts[1]}`
    const signature = Buffer.from(parts[2]!, 'base64url')

    const verify = crypto.createVerify('RSA-SHA256')
    verify.update(signingInput)
    expect(verify.verify(publicKey, signature)).toBe(true)
  })
})
