import { isSensitiveDiagnosticQueryKey } from '@ainyc/canonry-contracts'

/** Parse a Retry-After header into a non-negative millisecond delay. */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined
  const value = header.trim()
  if (!value) return undefined

  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const delayMs = Number(value) * 1_000
    return Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= Number.MAX_SAFE_INTEGER
      ? delayMs
      : undefined
  }

  // A signed number such as "-1" is neither a valid delta-seconds value nor
  // an HTTP-date. Date.parse accepts some of those implementation-specific
  // strings, so only attempt date parsing for the IMF-fixdate form servers use.
  if (!/^[a-z]{3},\s/i.test(value)) return undefined
  const target = Date.parse(value)
  if (!Number.isFinite(target)) return undefined
  const delayMs = Math.max(0, target - now)
  return Number.isSafeInteger(delayMs) ? delayMs : undefined
}

/** Preserve server details; expose retry timing only when the server supplies it. */
export function httpErrorDetails(serverDetails: unknown, response: Response): Record<string, unknown> {
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
  return {
    ...(serverDetails && typeof serverDetails === 'object' && !Array.isArray(serverDetails) ? serverDetails : {}),
    httpStatus: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(requestId ? { requestId } : {}),
  }
}

export function isConnectionFailure(message: string): boolean {
  return message.includes('fetch failed') || message.includes('ECONNREFUSED') || message.includes('connect ECONNREFUSED')
}

export function connectionFailureMessage(target: string): string {
  return `Could not connect to canonry server at ${redactRequestTarget(target)}. ` +
    'Check that this URL is reachable and the server is running. ' +
    'For a local Canonry instance, start it with "canonry serve" (or "canonry serve &" to run in background).'
}

/** Keep diagnostic output useful without ever displaying URL credentials. */
export function redactRequestTarget(target: string): string {
  try {
    const url = new URL(target)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveDiagnosticQueryKey(key)) {
        url.searchParams.set(key, '<redacted>')
      }
    }
    return url.toString()
  } catch {
    return target.replace(/\/\/[^/@]*@/, '//')
  }
}
