import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { verifyCanonryWebhook } from '../src/webhooks.js'
const secret = 'fixture-only-secret'
const now = Date.parse('2026-10-23T18:00:00Z')
const timestamp = String(now / 1000)
const eventId = 'evt_' + 'a'.repeat(64)
const body = JSON.stringify({ eventId, event: 'review.negative' })
const signature =
  'sha256=' +
  createHmac('sha256', secret)
    .update(timestamp + '.' + body)
    .digest('hex')
describe('signed review-event receiver verification', () => {
  it('verifies exact signed bytes and matching stable event identity', () =>
    expect(
      verifyCanonryWebhook(
        body,
        secret,
        { timestamp, signature, eventId },
        now,
      ),
    ).toBe(true))
  it('rejects replay outside the freshness window and wrong event IDs', () => {
    expect(
      verifyCanonryWebhook(
        body,
        secret,
        { timestamp, signature, eventId },
        now + 301000,
      ),
    ).toBe(false)
    expect(
      verifyCanonryWebhook(
        body,
        secret,
        { timestamp, signature, eventId: 'evt_' + 'b'.repeat(64) },
        now,
      ),
    ).toBe(false)
  })
  it('rejects changed body, secret, signature or missing headers without throwing', () => {
    expect(
      verifyCanonryWebhook(
        body + ' ',
        secret,
        { timestamp, signature, eventId },
        now,
      ),
    ).toBe(false)
    expect(
      verifyCanonryWebhook(
        body,
        'different',
        { timestamp, signature, eventId },
        now,
      ),
    ).toBe(false)
    expect(
      verifyCanonryWebhook(
        body,
        secret,
        { timestamp, signature: 'sha256=aa', eventId },
        now,
      ),
    ).toBe(false)
    expect(verifyCanonryWebhook(body, secret, {}, now)).toBe(false)
  })
})
