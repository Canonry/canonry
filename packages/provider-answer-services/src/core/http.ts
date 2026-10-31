import {
  asRecord,
  createSseParser,
  describeError,
  isRetryableHttpError,
  retryAfterDelayMs,
  withRetry,
  type AnswerServiceDescriptor,
  type SseEvent,
} from '@canonry/canonry-contracts'
import type { AnswerServiceHttpRequest, AnswerServiceStreamEnd } from './types.js'

/** Largest response read before giving up. A real answer is far smaller. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Bounded length of an upstream error message kept in a failure. */
const MAX_UPSTREAM_MESSAGE_CHARS = 300

/**
 * A non-success response. The message names the service and status (which
 * the shared error classifier reads) plus the vendor's own message, bounded.
 * Headers and the request body are never included.
 */
export class AnswerServiceHttpError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    readonly upstreamMessage: string | null,
    readonly retryAfter?: string,
    readonly requestId: string | null = null,
  ) {
    super(`${service} request failed (HTTP ${status})${upstreamMessage ? `: ${upstreamMessage}` : ''}`)
    this.name = 'AnswerServiceHttpError'
  }
}

export interface AnswerServiceTransportOptions {
  apiKey: string
  /** Per-attempt deadline. */
  timeoutMs: number
  /** Stops the call (and any retry wait) when aborted. */
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>
}

export interface JsonResponse {
  body: Record<string, unknown>
  requestId: string | null
  bytes: number
}

export interface StreamResponse {
  events: SseEvent[]
  ended: AnswerServiceStreamEnd
  /** The stream closed with an event still open. */
  unterminated: boolean
  requestId: string | null
  bytes: number
}

function authHeaders(descriptor: AnswerServiceDescriptor, apiKey: string): Record<string, string> {
  return descriptor.auth.scheme === 'bearer'
    ? { Authorization: `Bearer ${apiKey}` }
    : { [descriptor.auth.header]: apiKey }
}

function requestUrl(descriptor: AnswerServiceDescriptor, path: string): string {
  if (!path.startsWith('/')) throw new Error(`${descriptor.displayName} request path must start with /`)
  return `${descriptor.baseUrl.replace(/\/+$/, '')}${path}`
}

function signalFor(options: AnswerServiceTransportOptions): AbortSignal {
  const deadline = AbortSignal.timeout(options.timeoutMs)
  return options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
}

function requestIdOf(response: Response): string | null {
  return response.headers.get('x-request-id') ?? response.headers.get('request-id')
}

async function readBounded(response: Response): Promise<{ text: string; bytes: number }> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
  if (!response.body) return { text: '', bytes: 0 }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
    }
    text += decoder.decode(value, { stream: true })
  }
  return { text: text + decoder.decode(), bytes }
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function boundedMessage(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  return trimmed.length > MAX_UPSTREAM_MESSAGE_CHARS ? `${trimmed.slice(0, MAX_UPSTREAM_MESSAGE_CHARS)}…` : trimmed
}

async function failure(
  descriptor: AnswerServiceDescriptor,
  response: Response,
  errorMessage: ((body: unknown) => string | null) | undefined,
): Promise<AnswerServiceHttpError> {
  let message: string | null = null
  try {
    const { text } = await readBounded(response)
    const parsed = parseJsonText(text)
    message = errorMessage ? errorMessage(parsed) : null
  } catch {
    message = null
  }
  return new AnswerServiceHttpError(
    descriptor.displayName,
    response.status,
    boundedMessage(message),
    response.headers.get('retry-after') ?? undefined,
    requestIdOf(response),
  )
}

async function open(
  descriptor: AnswerServiceDescriptor,
  request: AnswerServiceHttpRequest,
  options: AnswerServiceTransportOptions,
  signal: AbortSignal,
  accept: string,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch
  return fetchImpl(requestUrl(descriptor, request.path), {
    method: request.method,
    headers: {
      ...request.headers,
      ...authHeaders(descriptor, options.apiKey),
      Accept: accept,
      ...(request.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    signal,
  })
}

async function fetchJsonOnce(
  descriptor: AnswerServiceDescriptor,
  request: AnswerServiceHttpRequest,
  options: AnswerServiceTransportOptions,
  errorMessage: ((body: unknown) => string | null) | undefined,
): Promise<JsonResponse> {
  const signal = signalFor(options)
  const response = await open(descriptor, request, options, signal, 'application/json')
  if (!response.ok) throw await failure(descriptor, response, errorMessage)
  const { text, bytes } = await readBounded(response)
  const body = asRecord(parseJsonText(text))
  if (!body) throw new Error(`${descriptor.displayName} returned a response that is not a JSON object`)
  return { body, requestId: requestIdOf(response), bytes }
}

async function fetchStreamOnce(
  descriptor: AnswerServiceDescriptor,
  request: AnswerServiceHttpRequest,
  options: AnswerServiceTransportOptions,
  isTerminal: (event: SseEvent) => boolean,
  errorMessage: ((body: unknown) => string | null) | undefined,
): Promise<StreamResponse> {
  const signal = signalFor(options)
  const response = await open(descriptor, request, options, signal, 'text/event-stream')
  if (!response.ok) throw await failure(descriptor, response, errorMessage)
  const requestId = requestIdOf(response)
  const events: SseEvent[] = []
  if (!response.body) return { events, ended: 'eof', unterminated: false, requestId, bytes: 0 }
  const parser = createSseParser()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let ended: AnswerServiceStreamEnd = 'eof'
  try {
    reading: for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        events.push(event)
        if (isTerminal(event)) {
          ended = 'terminal'
          break reading
        }
      }
    }
  } catch (error) {
    // The body already began, so this paid request is never retried: keep
    // what arrived and let the parser mark it partial.
    if (!signal.aborted) throw new AnswerServiceStreamError(descriptor.displayName, describeError(error), events, requestId)
    ended = 'aborted'
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const tail = ended === 'eof' ? parser.push(decoder.decode()) : []
  events.push(...tail)
  const { unterminated } = parser.end()
  return { events, ended, unterminated, requestId, bytes }
}

/** A stream that failed after it began. Never retried; carries what arrived. */
export class AnswerServiceStreamError extends Error {
  constructor(service: string, cause: string, readonly events: readonly SseEvent[], readonly requestId: string | null) {
    super(`${service} stream failed after it began: ${cause}`)
    this.name = 'AnswerServiceStreamError'
  }
}

/**
 * Retry rule for a paid answer request: only the statuses the vendor
 * documents as safe (throttles and declared server errors), and never once a
 * response body began. A dropped connection or deadline is not retried
 * either, because the upstream may already have billed the request.
 */
export function isRetryableAnswerRequest(descriptor: Pick<AnswerServiceDescriptor, 'retry'>, error: unknown): boolean {
  return error instanceof AnswerServiceHttpError && descriptor.retry.statuses.includes(error.status)
}

function retryOptions(options: AnswerServiceTransportOptions, isRetryable: (error: unknown) => boolean) {
  return {
    maxRetries: 2,
    baseDelayMs: 2000,
    isRetryable: (error: unknown) => !options.signal?.aborted && isRetryable(error),
    computeDelayMs: (_attempt: number, error: unknown, delay: number) => retryAfterDelayMs(error) ?? delay,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  }
}

/** The one HTTP entry point for a JSON answer request. */
export function requestJson(
  descriptor: AnswerServiceDescriptor,
  request: AnswerServiceHttpRequest,
  options: AnswerServiceTransportOptions,
  errorMessage?: (body: unknown) => string | null,
): Promise<JsonResponse> {
  return withRetry(
    () => fetchJsonOnce(descriptor, request, options, errorMessage),
    retryOptions(options, error => isRetryableAnswerRequest(descriptor, error)),
  )
}

/** The one HTTP entry point for a streamed answer request. Retries only before the stream opens. */
export function requestStream(
  descriptor: AnswerServiceDescriptor,
  request: AnswerServiceHttpRequest,
  options: AnswerServiceTransportOptions,
  isTerminal: (event: SseEvent) => boolean,
  errorMessage?: (body: unknown) => string | null,
): Promise<StreamResponse> {
  return withRetry(
    () => fetchStreamOnce(descriptor, request, options, isTerminal, errorMessage),
    retryOptions(options, error => isRetryableAnswerRequest(descriptor, error)),
  )
}

/**
 * A metadata request that proves a key without spending (the descriptor's
 * key check). Idempotent, so ordinary throttle, 5xx and network retries apply.
 */
export function requestKeyCheck(
  descriptor: AnswerServiceDescriptor,
  request: AnswerServiceHttpRequest,
  options: AnswerServiceTransportOptions,
): Promise<JsonResponse> {
  return withRetry(
    () => fetchJsonOnce(descriptor, request, options, undefined),
    retryOptions(options, isRetryableHttpError),
  )
}
