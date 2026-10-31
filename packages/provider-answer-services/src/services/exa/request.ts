import type { AnswerServiceBuiltRequest, AnswerServiceRequestInput } from '../../core/types.js'

/**
 * The `/answer` request: the unmodified query plus the profile's frozen
 * settings (`model`, `stream: false`, `text: false`), and `userLocation` only
 * when a country was offered. `userLocation.country` is documented as a
 * two-letter ISO 3166-1 code with no narrower list, so the offered code is
 * sent as is. No `systemPrompt`, `outputSchema` or `userIdentifier` is ever
 * sent.
 */
export function buildExaAnswerRequest({ query, profile, location }: AnswerServiceRequestInput): AnswerServiceBuiltRequest {
  const country = location.sent?.country
  return {
    request: {
      method: 'POST',
      path: '/answer',
      body: {
        query,
        ...profile.settings,
        ...(country ? { userLocation: { country } } : {}),
      },
    },
    sentLocation: country ? { country } : null,
  }
}
