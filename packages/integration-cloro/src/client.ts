import { isRetryableHttpError, retryAfterDelayMs, withRetry } from '@canonry/canonry-contracts'

export interface CloroCredentials {
  apiKey: string
  /** What one cloro credit costs this host, in microUSD. The host sets it from its cloro plan. */
  creditMicros: number
}

export interface CloroResponse {
  status: number
  /** `X-Credits-Charged`: the credits cloro billed for this request, or null when the header is missing. */
  creditsCharged: number | null
  requestId: string | null
  body: unknown
}

/** Never includes upstream bodies or credentials. */
export class CloroTransportError extends Error {
  constructor(
    readonly status: number,
    readonly throttle: boolean,
    readonly retryAfter: string | null = null,
  ) {
    super(throttle ? 'SEO provider rate limit exceeded.' : 'SEO provider request could not be completed.')
  }
}

/**
 * cloro asks for a client timeout of at least 5 minutes: it starts no new attempt after 5
 * minutes, but an attempt that is running can still finish and be charged.
 */
const TIMEOUT_MS = 360_000

function credits(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** `path` is the API path under `/v1/`, such as `monitor/google`. */
async function fetchOnce(credentials: CloroCredentials, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<CloroResponse> {
  const response = await fetch(`https://api.cloro.dev/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  })
  // cloro charges only for a 200, so every other status is a refusal that cost nothing.
  if (response.status !== 200) {
    // 429 and 503 ask for a wait. A 500 comes after cloro has already retried, so it is not sent again.
    const throttle = response.status === 429 || response.status === 503
    throw new CloroTransportError(response.status, throttle, response.headers.get('Retry-After'))
  }
  return {
    status: response.status,
    creditsCharged: credits(response.headers.get('X-Credits-Charged')),
    requestId: response.headers.get('X-Request-ID'),
    body: await response.json(),
  }
}

/** The only retry owner. A refusal is retried after a wait; a lost or unread response never is. */
export async function cloroFetch(credentials: CloroCredentials, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<CloroResponse> {
  let refusal: CloroTransportError | null = null
  return withRetry(() => {
    if (signal?.aborted) throw refusal ?? new Error('SEO request was cancelled.')
    return fetchOnce(credentials, path, body, signal)
  }, {
    maxRetries: 2, baseDelayMs: 2000, maxDelayMs: 30_000,
    isRetryable: error => !signal?.aborted && error instanceof CloroTransportError && error.throttle && isRetryableHttpError(error),
    computeDelayMs: (_attempt, error, defaultMs) => retryAfterDelayMs(error) ?? defaultMs,
    onRetry: ({ err }) => { if (err instanceof CloroTransportError) refusal = err },
    sleep: ms => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(refusal ?? new Error('SEO request was cancelled.')); return }
      const cancelled = () => { clearTimeout(timer); reject(refusal ?? new Error('SEO request was cancelled.')) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', cancelled); resolve() }, ms)
      signal?.addEventListener('abort', cancelled, { once: true })
    }),
  })
}
