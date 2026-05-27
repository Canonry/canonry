import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyRequestSignature } from '../src/verify.js'

const SECRET = 'shared-hmac-secret'

function sign(timestamp: number | string, body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

describe('verifyRequestSignature', () => {
  const now = Math.floor(Date.parse('2026-05-27T15:30:00Z') / 1000)
  const body = '{"events":[{"eventId":"r1"}]}'

  it('accepts a correct signature within the timestamp window', () => {
    const ts = String(now)
    const signature = sign(ts, body)
    expect(verifyRequestSignature({
      timestamp: ts,
      signature,
      body,
      secret: SECRET,
      nowSeconds: now,
    })).toEqual({ ok: true })
  })

  it('rejects a mutated body', () => {
    const ts = String(now)
    const signature = sign(ts, body)
    expect(verifyRequestSignature({
      timestamp: ts,
      signature,
      body: body + 'x',
      secret: SECRET,
      nowSeconds: now,
    })).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('rejects a mutated timestamp', () => {
    const ts = String(now)
    const signature = sign(ts, body)
    expect(verifyRequestSignature({
      timestamp: String(now + 1),
      signature,
      body,
      secret: SECRET,
      nowSeconds: now,
    })).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('rejects the wrong secret', () => {
    const ts = String(now)
    const signature = sign(ts, body, 'wrong-secret')
    expect(verifyRequestSignature({
      timestamp: ts,
      signature,
      body,
      secret: SECRET,
      nowSeconds: now,
    })).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('rejects an expired timestamp (older than maxAgeSeconds)', () => {
    const ts = String(now - 301)
    const signature = sign(ts, body)
    expect(verifyRequestSignature({
      timestamp: ts,
      signature,
      body,
      secret: SECRET,
      nowSeconds: now,
      maxAgeSeconds: 300,
    })).toEqual({ ok: false, reason: 'timestamp_expired' })
  })

  it('rejects a timestamp too far in the future', () => {
    const ts = String(now + 301)
    const signature = sign(ts, body)
    expect(verifyRequestSignature({
      timestamp: ts,
      signature,
      body,
      secret: SECRET,
      nowSeconds: now,
      maxAgeSeconds: 300,
    })).toEqual({ ok: false, reason: 'timestamp_expired' })
  })

  it('rejects a non-numeric timestamp', () => {
    const signature = sign('not-a-number', body)
    expect(verifyRequestSignature({
      timestamp: 'not-a-number',
      signature,
      body,
      secret: SECRET,
      nowSeconds: now,
    })).toEqual({ ok: false, reason: 'timestamp_invalid' })
  })

  it('rejects an empty timestamp', () => {
    expect(verifyRequestSignature({
      timestamp: '',
      signature: sign('', body),
      body,
      secret: SECRET,
      nowSeconds: now,
    })).toEqual({ ok: false, reason: 'timestamp_invalid' })
  })

  it('rejects a malformed hex signature', () => {
    expect(verifyRequestSignature({
      timestamp: String(now),
      signature: 'not-hex!!',
      body,
      secret: SECRET,
      nowSeconds: now,
    })).toEqual({ ok: false, reason: 'signature_invalid' })
  })

  it('rejects a signature of the wrong byte length', () => {
    expect(verifyRequestSignature({
      timestamp: String(now),
      signature: 'aabb',
      body,
      secret: SECRET,
      nowSeconds: now,
    })).toEqual({ ok: false, reason: 'signature_invalid' })
  })

  it('verifies correctly when body is empty', () => {
    const ts = String(now)
    const signature = sign(ts, '')
    expect(verifyRequestSignature({
      timestamp: ts,
      signature,
      body: '',
      secret: SECRET,
      nowSeconds: now,
    })).toEqual({ ok: true })
  })

  it('uses 300s default window when maxAgeSeconds is omitted', () => {
    const ts = String(now - 299)
    const signature = sign(ts, body)
    expect(verifyRequestSignature({
      timestamp: ts,
      signature,
      body,
      secret: SECRET,
      nowSeconds: now,
    })).toEqual({ ok: true })

    const expiredTs = String(now - 301)
    const expiredSig = sign(expiredTs, body)
    expect(verifyRequestSignature({
      timestamp: expiredTs,
      signature: expiredSig,
      body,
      secret: SECRET,
      nowSeconds: now,
    })).toEqual({ ok: false, reason: 'timestamp_expired' })
  })
})
