import Anthropic, { APIError } from '@anthropic-ai/sdk'
import type {
  BatchCreateParams,
  MessageBatch,
  MessageBatchErroredResult,
  MessageBatchIndividualResponse,
} from '@anthropic-ai/sdk/resources/messages/batches.js'
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages/messages.js'
import { ProviderBatchSubmitError, describeError, isRetryableHttpError, retryAfterDelayMs } from '@ainyc/canonry-contracts'
import type {
  ProviderBatchCapability,
  ProviderBatchPollResult,
  ProviderBatchRequestInput,
  ProviderBatchResultLine,
  ProviderBatchSubmitResult,
  ProviderConfig,
} from '@ainyc/canonry-contracts'
import { CLAUDE_MESSAGES_ENDPOINT, responseToRecord } from './normalize.js'
import { withRetry } from './utils.js'

/**
 * Message Batches for tracked queries (#1201).
 *
 * Each line carries the exact body `buildTrackedQueryRequest` returns, and a
 * succeeded line's message is read back by `parseTrackedQueryResponse`, so a
 * batch answer is the sync answer at half the token price. Web search is
 * billed at the full price in both modes.
 *
 * Retries are canonry's, not the SDK's (`maxRetries: 0`): a submit that may
 * have created a batch must never be sent twice, and the SDK would otherwise
 * retry timeouts and 5xx on its own.
 *
 * Docs: https://platform.claude.com/docs/en/build-with-claude/batch-processing
 */

export interface ClaudeBatchOptions {
  /** Base delay of the retry backoff, in ms. Defaults to the provider-wide 1000ms. */
  retryBaseDelayMs?: number
}

/**
 * 4xx statuses that do not prove the batch was refused: a request timeout
 * (408) or a conflict (409) can be answered after the body was accepted.
 * Every other 4xx is a rejection before anything was created.
 */
const AMBIGUOUS_CLIENT_ERROR_STATUSES: ReadonlySet<number> = new Set([408, 409])

/** Batch states in which a cancel has nothing left to do. */
const CANCEL_SETTLED_STATUSES: ReadonlySet<MessageBatch['processing_status']> = new Set(['canceling', 'ended'])

function isDefiniteRejection(err: unknown): boolean {
  if (!(err instanceof APIError) || typeof err.status !== 'number') return false
  return err.status >= 400 && err.status < 500 && !AMBIGUOUS_CLIENT_ERROR_STATUSES.has(err.status)
}

/** A rate limit is a rejection before acceptance, so it alone is safe to resubmit. */
function isRateLimitRejection(err: unknown): boolean {
  return err instanceof APIError && err.status === 429
}

/**
 * Reads and cancels are idempotent, so they retry the usual transient
 * failures. A local SDK error (not an `APIError`, e.g. results asked of a
 * batch that has not ended) will not change on a retry.
 */
function isRetryableBatchCall(err: unknown): boolean {
  return err instanceof APIError && isRetryableHttpError(err)
}

function honourRetryAfter(_attempt: number, err: unknown, defaultMs: number): number {
  return retryAfterDelayMs(err) ?? defaultMs
}

function createBatchClient(config: ProviderConfig, onSend?: () => void): Anthropic {
  return new Anthropic({
    apiKey: config.apiKey ?? '',
    maxRetries: 0,
    ...(onSend
      ? {
          fetch: (input, init) => {
            onSend()
            return globalThis.fetch(input, init)
          },
        }
      : {}),
  })
}

function toPollResult(batch: MessageBatch): ProviderBatchPollResult {
  const counts = batch.request_counts
  return {
    status: batch.processing_status,
    requestCounts: {
      processing: counts.processing,
      succeeded: counts.succeeded,
      errored: counts.errored,
      canceled: counts.canceled,
      expired: counts.expired,
    },
    ...(batch.ended_at ? { endedAt: batch.ended_at } : {}),
    // `expires_at` is the processing deadline (24h after creation), not the
    // results' lifetime. The API states when results became unavailable only
    // once it happens, as `archived_at`.
    ...(batch.archived_at ? { resultsExpireAt: batch.archived_at } : {}),
  }
}

function describeErroredResult(result: MessageBatchErroredResult): string {
  const inner = result.error?.error
  return inner ? `${inner.type}: ${inner.message}` : describeError(result.error)
}

function toResultLine(line: MessageBatchIndividualResponse): ProviderBatchResultLine {
  const customId = line.custom_id
  const result = line.result
  switch (result.type) {
    case 'succeeded':
      return { customId, type: 'succeeded', body: responseToRecord(result.message) }
    case 'errored':
      return { customId, type: 'errored', error: `[provider-claude] ${describeErroredResult(result)}` }
    case 'canceled':
      return { customId, type: 'canceled', error: '[provider-claude] the batch was canceled before this request was processed' }
    case 'expired':
      return { customId, type: 'expired', error: '[provider-claude] the batch expired before this request was processed' }
    default: {
      // A result type newer than this SDK: the slot was not answered.
      const unrecognized: never = result
      return { customId, type: 'errored', error: `[provider-claude] unrecognized batch result: ${describeError(unrecognized)}` }
    }
  }
}

export function createClaudeBatchCapability(options: ClaudeBatchOptions = {}): ProviderBatchCapability {
  const initialDelay = options.retryBaseDelayMs

  return {
    maxRequestsPerBatch: 100_000,
    maxBytesPerBatch: 256 * 1024 * 1024,
    defaultDeadlineHours: 24,

    async submit(requests: readonly ProviderBatchRequestInput[], config: ProviderConfig): Promise<ProviderBatchSubmitResult> {
      if (requests.length === 0) {
        throw new ProviderBatchSubmitError('[provider-claude] a batch needs at least one request', { definite: true })
      }
      const foreign = requests.find((r) => r.request.endpoint !== CLAUDE_MESSAGES_ENDPOINT)
      if (foreign) {
        throw new ProviderBatchSubmitError(
          `[provider-claude] batch request ${foreign.customId} targets ${foreign.request.endpoint}, not ${CLAUDE_MESSAGES_ENDPOINT}`,
          { definite: true },
        )
      }

      const params: BatchCreateParams = {
        requests: requests.map((r) => ({
          custom_id: r.customId,
          params: r.request.body as unknown as MessageCreateParamsNonStreaming,
        })),
      }
      // Whether the current attempt reached the network. An attempt that
      // failed before sending cannot have created a batch.
      let sent = false
      const client = createBatchClient(config, () => {
        sent = true
      })

      try {
        const batch = await withRetry(
          () => {
            sent = false
            return client.messages.batches.create(params)
          },
          { initialDelay, isRetryable: isRateLimitRejection, computeDelayMs: honourRetryAfter },
        )
        return { providerBatchId: batch.id, expiresAt: batch.expires_at }
      } catch (err: unknown) {
        // Only the last attempt can be uncertain: every earlier one was a
        // rate-limit rejection, or it would not have been retried.
        throw new ProviderBatchSubmitError(`[provider-claude] batch submit failed: ${describeError(err)}`, {
          definite: !sent || isDefiniteRejection(err),
          cause: err,
        })
      }
    },

    async poll(providerBatchId: string, config: ProviderConfig): Promise<ProviderBatchPollResult> {
      const client = createBatchClient(config)
      try {
        const batch = await withRetry(() => client.messages.batches.retrieve(providerBatchId), {
          initialDelay,
          isRetryable: isRetryableBatchCall,
          computeDelayMs: honourRetryAfter,
        })
        return toPollResult(batch)
      } catch (err: unknown) {
        throw new Error(`[provider-claude] batch poll failed: ${describeError(err)}`, { cause: err })
      }
    },

    async *results(providerBatchId: string, config: ProviderConfig): AsyncIterable<ProviderBatchResultLine> {
      const client = createBatchClient(config)
      try {
        // Opening the stream is retried; a stream that breaks midway throws,
        // and the caller re-reads it (ingest is keyed by custom_id).
        const lines = await withRetry(() => client.messages.batches.results(providerBatchId), {
          initialDelay,
          isRetryable: isRetryableBatchCall,
          computeDelayMs: honourRetryAfter,
        })
        for await (const line of lines) {
          yield toResultLine(line)
        }
      } catch (err: unknown) {
        throw new Error(`[provider-claude] batch results failed: ${describeError(err)}`, { cause: err })
      }
    },

    async cancel(providerBatchId: string, config: ProviderConfig): Promise<void> {
      const client = createBatchClient(config)
      const retryOptions = { initialDelay, isRetryable: isRetryableBatchCall, computeDelayMs: honourRetryAfter }
      try {
        await withRetry(() => client.messages.batches.cancel(providerBatchId), retryOptions)
      } catch (err: unknown) {
        // A batch that already ended, or is already canceling, has nothing
        // left to cancel: that is success, whatever the refusal said.
        const current = await withRetry(() => client.messages.batches.retrieve(providerBatchId), retryOptions)
          .catch(() => null)
        if (current && CANCEL_SETTLED_STATUSES.has(current.processing_status)) return
        throw new Error(`[provider-claude] batch cancel failed: ${describeError(err)}`, { cause: err })
      }
    },
  }
}

export const claudeBatch = createClaudeBatchCapability()
