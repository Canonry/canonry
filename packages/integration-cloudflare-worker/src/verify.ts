import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_MAX_AGE_SECONDS = 300

export type VerifyRequestSignatureFailureReason =
  | 'timestamp_invalid'
  | 'timestamp_expired'
  | 'signature_invalid'
  | 'signature_mismatch'

export type VerifyRequestSignatureResult =
  | { ok: true }
  | { ok: false; reason: VerifyRequestSignatureFailureReason }

export interface VerifyRequestSignatureOptions {
  timestamp: string
  signature: string
  body: string
  secret: string
  /** Override for tests; defaults to `Date.now() / 1000`. */
  nowSeconds?: number
  /** Acceptable clock skew on either side of `nowSeconds`. */
  maxAgeSeconds?: number
}

/**
 * Verify the HMAC-SHA256 signature on a Cloudflare Worker → canonry ingest
 * request. The signing convention is `hex(hmac_sha256(secret, timestamp + "." + body))`
 * over the request's `X-Canonry-Timestamp` (Unix seconds) and the raw body
 * string. Verification is constant-time once the inputs are well-formed.
 *
 * Failure reasons are intentionally specific (`timestamp_invalid` vs
 * `timestamp_expired` vs `signature_invalid` vs `signature_mismatch`) so
 * the receiver can log and rate-limit appropriately, but the caller MUST
 * NOT echo the reason back to the Worker — exposing whether the failure
 * was bearer/HMAC/timestamp lets an attacker enumerate which leg of the
 * auth they're missing.
 */
export function verifyRequestSignature(opts: VerifyRequestSignatureOptions): VerifyRequestSignatureResult {
  const { timestamp, signature, body, secret } = opts
  if (timestamp === '' || !/^-?\d+$/.test(timestamp)) {
    return { ok: false, reason: 'timestamp_invalid' }
  }
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp_invalid' }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  if (Math.abs(now - ts) > maxAge) return { ok: false, reason: 'timestamp_expired' }

  if (signature === '' || !/^[0-9a-f]+$/i.test(signature)) {
    return { ok: false, reason: 'signature_invalid' }
  }
  let provided: Buffer
  try {
    provided = Buffer.from(signature, 'hex')
  } catch {
    return { ok: false, reason: 'signature_invalid' }
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest()
  if (provided.length !== expected.length) return { ok: false, reason: 'signature_invalid' }
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'signature_mismatch' }
  return { ok: true }
}
