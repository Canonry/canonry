import { z } from 'zod'
import { isRetryableHttpError, retryAfterDelayMs, withRetry } from '@canonry/canonry-contracts'

const taskSchema = z.object({
  id: z.string().nullish(), status_code: z.number().int(),
  cost: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER / 1_000_000).nullish(), result: z.array(z.unknown()).nullish(),
})
export const dataForSeoEnvelopeSchema = z.object({
  status_code: z.number().int(), cost: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER / 1_000_000).nullish(),
  tasks: z.array(taskSchema).nullish(),
})
export type DataForSeoEnvelope = z.infer<typeof dataForSeoEnvelopeSchema>
export interface DataForSeoCredentials { login: string; password: string }

/** Never includes upstream bodies, credentials, or provider billing explanations. */
export class DataForSeoTransportError extends Error {
  constructor(
    readonly status: number,
    readonly unaccepted: boolean,
    readonly throttle: boolean,
    readonly retryAfter: string | null = null,
  ) {
    super(throttle ? 'SEO provider rate limit exceeded.' : 'SEO provider request could not be completed.')
  }
}

async function fetchOnce(
  credentials: DataForSeoCredentials, endpoint: string, task: Record<string, unknown>, signal?: AbortSignal,
): Promise<DataForSeoEnvelope> {
  const response = await fetch(`https://api.dataforseo.com/v3/dataforseo_labs/google/${endpoint}/live`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([task]),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    // Explicit gateway rejection is safe to repeat; a 5xx or lost response is not.
    const throttle = response.status === 429
    const unaccepted = throttle || response.status === 401 || response.status === 403 || response.status === 400
    throw new DataForSeoTransportError(response.status, unaccepted, throttle, response.headers.get('Retry-After'))
  }
  const envelope = dataForSeoEnvelopeSchema.parse(await response.json())
  const tasks = envelope.tasks ?? []
  const rateCodes = new Set([40202, 40209])
  // A whole request rejected with explicit zero task charges can be retried.
  // Never retry the successful siblings of a partially accepted batch.
  const allTasksRejected = tasks.length > 0 && tasks.every(item => rateCodes.has(item.status_code) && item.cost === 0)
  const requestRejected = tasks.length === 0 && rateCodes.has(envelope.status_code) && envelope.cost === 0
  if (allTasksRejected || requestRejected) {
    throw new DataForSeoTransportError(429, true, true, response.headers.get('Retry-After'))
  }
  return envelope
}

/** The only retry owner. Callers must persist ambiguity rather than retrying a paid submission. */
export async function dataForSeoFetch(
  credentials: DataForSeoCredentials, endpoint: string, task: Record<string, unknown>, signal?: AbortSignal,
): Promise<DataForSeoEnvelope> {
  return withRetry(() => fetchOnce(credentials, endpoint, task, signal), {
    maxRetries: 2, baseDelayMs: 2000, maxDelayMs: 30_000,
    isRetryable: error => !signal?.aborted && error instanceof DataForSeoTransportError
      && error.unaccepted && error.throttle && isRetryableHttpError(error),
    computeDelayMs: (_attempt, error, defaultMs) => retryAfterDelayMs(error) ?? defaultMs,
  })
}
