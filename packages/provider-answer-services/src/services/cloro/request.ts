import type { AnswerServiceBuiltRequest, AnswerServiceRequestInput } from '../../core/types.js'
import { CLORO_DEFAULT_COUNTRY } from './descriptor.js'

/**
 * The `/v1/monitor/<surface>` request: the unmodified query as `prompt` and a
 * `country`, which cloro requires. `country` must be an uppercase ISO 3166-1
 * alpha-2 code, so the offered country is sent in upper case. Without a
 * usable country, `US` is sent and reported as not sent, so the location is
 * stored as ignored or not requested, with `US` as the service default.
 * No `include`, `state`, `legacy`, `disableWebSearch` or multi-turn prompt is
 * ever sent: each changes the answer or the credit cost.
 */
export function buildCloroMonitorRequest({ query, profile, location }: AnswerServiceRequestInput): AnswerServiceBuiltRequest {
  const offered = location.sent?.country?.trim().toUpperCase()
  const country = offered && /^[A-Z]{2}$/.test(offered) ? offered : null
  return {
    request: {
      method: 'POST',
      path: `/v1/monitor/${profile.id}`,
      body: { prompt: query, country: country ?? CLORO_DEFAULT_COUNTRY },
    },
    sentLocation: country ? { country } : null,
  }
}
