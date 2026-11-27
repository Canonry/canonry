import crypto from 'node:crypto'

/**
 * HMAC-SHA256 (hex) under the install's journeys secret over a namespaced
 * identity, so per-visitor ingest state stores neither an address nor a user
 * agent. The namespace keeps keys for different stores apart; the parts are
 * serialized as one JSON array, so changing their order changes every key.
 */
export function keyedIdentityHash(secret: string, namespace: string, parts: readonly unknown[]): string {
  return crypto.createHmac('sha256', secret).update(JSON.stringify([namespace, ...parts])).digest('hex')
}

/** Rows per `inArray` read: far below SQLite's bound-parameter limit. */
export const KEY_CHUNK = 500

/** `items` split into consecutive slices of at most `size`, for chunked `inArray` reads. */
export function chunks<T>(items: readonly T[], size = KEY_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
