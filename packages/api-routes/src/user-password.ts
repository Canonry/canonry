/**
 * Password storage for named accounts.
 *
 * A password is user-chosen and therefore likely reused from somewhere else, so
 * a stolen database must not be a wordlist away from every account. Storage is
 * salted scrypt with a per-password random salt, in the same self-describing
 * `scrypt$1$<salt>$<digest>` format the install already uses elsewhere, so the
 * version field leaves room to move to a stronger derivation later without
 * stranding existing accounts.
 *
 * Nothing in this module accepts a logger, and the plaintext never leaves the
 * argument it arrived in. The bearer-token path deliberately does NOT go
 * through here: those are 128-bit random tokens with no guessing exposure, and
 * they stay on the fast SHA-256 path in `auth.ts`.
 */
import crypto from 'node:crypto'
import { promisify } from 'node:util'

/**
 * Deliberately the ASYNC scrypt. The sign-in route is public and unauthenticated,
 * so every derivation it performs is work an anonymous caller can ask for. Run
 * on the event loop, a couple of dozen such requests stop the server answering
 * anything at all — the derivation is expensive on purpose, which is exactly
 * what makes it a lever. On the threadpool it costs a worker, not the loop.
 */
const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>

const SCRYPT_KEYLEN = 64
/** N=32768 — roughly 80ms on a current laptop. */
const SCRYPT_COST = 1 << 15
/**
 * Node's default scrypt `maxmem` is 32 MiB, which is exactly at the boundary
 * for this N (128 * 32768 * 8 ≈ 32 MiB). 64 MiB leaves headroom.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024
const SALT_BYTES = 16

/** Every stored password digest starts with this; anything else matches no password. */
export const SCRYPT_DIGEST_PREFIX = 'scrypt$1$'
const PREFIX = SCRYPT_DIGEST_PREFIX

/** Derive the stored form of a password. Never returns anything reversible. */
export async function hashUserPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES)
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    maxmem: SCRYPT_MAXMEM,
  })
  return `${PREFIX}${salt.toString('base64')}$${derived.toString('base64')}`
}

/**
 * Check a candidate against a stored digest.
 *
 * Returns false — never throws — for a malformed or unrecognized stored value,
 * so a corrupted row locks one account out instead of failing the whole
 * sign-in route.
 */
export async function verifyUserPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash.startsWith(PREFIX)) return false
  const parts = storedHash.split('$')
  if (parts.length !== 4) return false
  const saltB64 = parts[2]
  const hashB64 = parts[3]
  if (!saltB64 || !hashB64) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltB64, 'base64')
    expected = Buffer.from(hashB64, 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  const derived = await scrypt(password, salt, expected.length, {
    N: SCRYPT_COST,
    maxmem: SCRYPT_MAXMEM,
  })
  if (derived.length !== expected.length) return false
  return crypto.timingSafeEqual(derived, expected)
}
