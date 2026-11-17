import type { AnswerServiceBuiltRequest, AnswerServiceRequestInput } from '../../core/types.js'

/**
 * The `/api/v1/google-ai-overview` request: the unmodified query plus the
 * profile's frozen settings (`output: 'json'`), and `country` only when a
 * country was offered. GoAnyAPI documents `country` as a two-letter code ("for
 * example us or gb"), so the offered code is sent lowercased in the vendor's
 * own encoding. No `language`, `device`, `page_token`, `html` or
 * `json_restrictor` is ever sent.
 */
export function buildGoanyapiAiOverviewRequest({ query, profile, location }: AnswerServiceRequestInput): AnswerServiceBuiltRequest {
  const country = location.sent?.country
  const sentCountry = country ? country.toLowerCase() : undefined
  return {
    request: {
      method: 'POST',
      path: '/api/v1/google-ai-overview',
      body: {
        query,
        ...profile.settings,
        ...(sentCountry ? { country: sentCountry } : {}),
      },
    },
    sentLocation: sentCountry ? { country: sentCountry } : null,
  }
}
