import crypto from 'node:crypto'
import { AppError, usageSurfaceSchema } from '@canonry/canonry-contracts'
import { currentOutcomeAttribution } from './request-context.js'

/**
 * Memory of recent credential checks against an upstream (Google, Bing), so a
 * client that re-sends the same connect in a loop does not cost an upstream
 * call every time. In October 2026 one install re-sent a GA4 connect that
 * Google refused about 680 times a day, each a token exchange and a report
 * request on the customer's own Google credentials.
 *
 * Keys hash everything a check depends on (credential, property, project), so
 * a changed credential or property is checked again at once.
 */
export const CONNECTION_VERIFY_TTL_MS = 15 * 60 * 1000
export const REFUSALS_BEFORE_BACKOFF = 3
const FIRST_BACKOFF_MS = 5 * 60 * 1000
const MAX_BACKOFF_MS = 60 * 60 * 1000
const MAX_ENTRIES = 500

function remember<V>(entries: Map<string, V>, key: string, value: V): void {
  entries.delete(key)
  entries.set(key, value)
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string)
}

/**
 * Whether a person is behind the current request: canonry's CLI or the
 * dashboard. They are always checked again; only other API clients use the
 * memory and wait out a backoff. Same rules as the host's `api.request`
 * surface (a valid `x-canonry-surface` label, else the user agent). Both are
 * caller-controlled, so this only decides who waits, never what anyone may do.
 */
export function isInteractiveCaller(): boolean {
  const attribution = currentOutcomeAttribution()
  const label = usageSurfaceSchema.safeParse(attribution?.surfaceLabel)
  if (label.success) return label.data === 'cli' || label.data === 'dashboard'
  const ua = attribution?.userAgent ?? ''
  return ua.startsWith('canonry-cli') || ua.startsWith('Mozilla/')
}

export function verifyCacheKey(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

/** What a passing check returned, kept for `ttlMs` so an unchanged repeat skips the upstream. */
export function createVerifyCache<T>(ttlMs = CONNECTION_VERIFY_TTL_MS) {
  const entries = new Map<string, { value: T; at: number }>()
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (Date.now() - entry.at < ttlMs) return entry.value
      entries.delete(key)
      return undefined
    },
    set(key: string, value: T): void {
      remember(entries, key, { value, at: Date.now() })
    },
  }
}

/**
 * Refusals that keep coming back. The first REFUSALS_BEFORE_BACKOFF are always
 * checked again, so an operator who grants access and retries is not held
 * back. After that the last refusal is replayed for a growing time (5 minutes,
 * doubling, at most an hour) before the upstream is asked again.
 */
export function createRefusalBackoff() {
  const entries = new Map<string, { count: number; at: number; error: AppError; cause: unknown }>()
  return {
    /** The refusal to answer with instead of asking the upstream, while this key is backing off. */
    replay(key: string): { error: AppError; cause: unknown } | undefined {
      const entry = entries.get(key)
      if (!entry || entry.count < REFUSALS_BEFORE_BACKOFF) return undefined
      const wait = Math.min(FIRST_BACKOFF_MS * 2 ** (entry.count - REFUSALS_BEFORE_BACKOFF), MAX_BACKOFF_MS)
      const nextCheckAt = entry.at + wait
      if (Date.now() >= nextCheckAt) return undefined
      const { error } = entry
      return {
        error: new AppError(error.code, error.message, error.statusCode, {
          ...error.details,
          nextCheckAt: new Date(nextCheckAt).toISOString(),
        }),
        cause: entry.cause,
      }
    },
    refused(key: string, error: AppError, cause: unknown): void {
      remember(entries, key, { count: (entries.get(key)?.count ?? 0) + 1, at: Date.now(), error, cause })
    },
    cleared(key: string): void {
      entries.delete(key)
    },
  }
}
