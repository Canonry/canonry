import type { AnswerServiceBuiltRequest, AnswerServiceRequestInput } from '../../core/types.js'
import { PARALLEL_EFFORT_SETTING } from './descriptor.js'

/**
 * The `/v1/responses` request: the unmodified query as `input`, plus the
 * profile's frozen `model`, `reasoning.effort` and `stream: false`. No
 * `instructions`, `tools`, `data_sources`, `text`, `metadata`,
 * `previous_response_id` or `background` is ever sent. The location is not
 * sent either: Parallel takes none (see the descriptor).
 */
export function buildParallelResponsesRequest({ query, profile }: AnswerServiceRequestInput): AnswerServiceBuiltRequest {
  const { model, stream } = profile.settings
  const effort = profile.settings[PARALLEL_EFFORT_SETTING]
  if (typeof model !== 'string' || typeof effort !== 'string' || typeof stream !== 'boolean') {
    throw new Error(`Parallel profile "${profile.id}" is missing its model, effort or stream setting.`)
  }
  return {
    request: {
      method: 'POST',
      path: '/v1/responses',
      body: { model, input: query, reasoning: { effort }, stream },
    },
    sentLocation: null,
  }
}
