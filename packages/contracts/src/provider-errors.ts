/**
 * Classification of raw provider failure text into a stable bucket.
 *
 * Provider adapters throw plain `Error`s carrying whatever the upstream API
 * said, so the only signal available is the message. Best-effort regex match.
 *
 * Lives here because every caller needs the same answer and must not drift: the
 * job runner, which stamps `errorCode` on `run.completed` and a per-provider
 * `code` on the stored run error, and the query generation route, which has to
 * preserve the provider's failure kind instead of flattening it to
 * `INTERNAL_ERROR` on the way to the dashboard.
 *
 * One decision rests on it: run admission refuses new runs after a streak of
 * runs in which every provider failed on its account (`isProviderAccountFailure`).
 * `PROVIDER_AUTH` is a written 401/403 status or auth wording, which covers a rejected key
 * and also access the account lacks (a region, a disabled API, a blocking
 * proxy). Both are standing failures that a retry cannot fix until someone
 * changes something, which is what the rule needs. It backs off to one run a
 * day rather than stopping for good, and `force` overrides it.
 */
import { z } from 'zod'

export const providerErrorCodeSchema = z.enum([
  'PROVIDER_AUTH',
  'PROVIDER_BILLING',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'NETWORK',
  'TIMEOUT',
  'PARSE_ERROR',
  'UNKNOWN',
])
export type ProviderErrorCode = z.infer<typeof providerErrorCodeSchema>
export const ProviderErrorCodes = providerErrorCodeSchema.enum

/**
 * A failure only the operator can fix, in the provider's console: a rejected
 * key or an account out of credit. Retrying cannot help until they act.
 */
export function isProviderAccountFailure(code: ProviderErrorCode | null | undefined): boolean {
  return code === ProviderErrorCodes.PROVIDER_AUTH || code === ProviderErrorCodes.PROVIDER_BILLING
}

/**
 * Priority when several providers fail differently in one run: report the one
 * an operator can act on first. Auth and billing are standing account
 * problems, a rate limit is a retry, and `UNKNOWN` is what is left when
 * nothing matched.
 */
const PROVIDER_ERROR_PRIORITY: readonly ProviderErrorCode[] = [
  'PROVIDER_AUTH',
  'PROVIDER_BILLING',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'NETWORK',
  'PARSE_ERROR',
  'UNKNOWN',
]

export function classifyProviderErrorMessage(message: string): ProviderErrorCode {
  // A number counts as an HTTP status only where one is written (see
  // `extractProviderHttpStatus`), never anywhere in the text: canonry's own
  // messages carry counts ("401 queries used today") that are not statuses.
  const status = extractProviderHttpStatus(message)
  // Gemini rejects a bad or expired key with a 400 INVALID_ARGUMENT, so only
  // its wording says auth: "API key not valid", "API_KEY_INVALID", "API key expired".
  if (
    status === 401
    || status === 403
    || /unauthorized|forbidden|invalid[_ -]?api[_ -]?key|missing[_ -]?api[_ -]?key|api[_ -]?key[_ -]?(?:is[_ -]?)?(?:not[_ -]?valid|invalid|expired)|authentication/i.test(message)
  ) {
    return 'PROVIDER_AUTH'
  }
  // An account out of credit fails every run until someone pays, so it must
  // not read as a retryable rate limit. Checked before the 429 rule because
  // OpenAI reports an exhausted balance as a 429. Gemini words its
  // per-minute and per-day limits the same way ("You exceeded your current
  // quota") but always tags them `RESOURCE_EXHAUSTED`, so those stay
  // `RATE_LIMITED`.
  if (
    status === 402
    || /payment required|credit balance|insufficient[_ -]?(?:quota|credits?|balance|funds)/i.test(message)
    || (/exceeded your current quota/i.test(message) && !/RESOURCE_EXHAUSTED/.test(message))
  ) {
    return 'PROVIDER_BILLING'
  }
  if (status === 429 || /rate[_ -]?limit|too many requests|quota[_ -]?exceeded/i.test(message)) {
    return 'RATE_LIMITED'
  }
  // A provider-side outage (5xx, Anthropic's 529 "overloaded") is not ours to
  // fix and not the operator's either. Checked before timeout/network so a
  // "503 Service Unavailable" is never counted as a local connectivity issue.
  if ((status !== undefined && status >= 500) || /overloaded|service unavailable|bad gateway|internal server error/i.test(message)) {
    return 'PROVIDER_UNAVAILABLE'
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
    return 'TIMEOUT'
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket hang up/i.test(message)) {
    return 'NETWORK'
  }
  if (/parse|unexpected token|invalid json|malformed|JSON\.parse/i.test(message)) {
    return 'PARSE_ERROR'
  }
  return 'UNKNOWN'
}

/** Collapse a set of per-provider failure messages to one reportable code. */
export function classifyProviderErrorMessages(
  messages: Iterable<string>,
): ProviderErrorCode {
  const codes = new Set<ProviderErrorCode>()
  for (const message of messages) {
    codes.add(classifyProviderErrorMessage(message))
  }
  for (const code of PROVIDER_ERROR_PRIORITY) {
    if (codes.has(code)) return code
  }
  return 'UNKNOWN'
}

/**
 * The HTTP status a provider failure carried, read back out of its message.
 *
 * Provider adapters rethrow SDK errors as plain `Error`s, and batch runs persist
 * only the message, so the text is the one place the status survives on every
 * path. The OpenAI and Anthropic SDKs lead the message with it (`429 Rate limit
 * reached…`), Gemini embeds it in its JSON body (`"code":429`) or as `got status:
 * 429`. Telemetry only: an unparseable message yields `undefined`, never a guess.
 */
export function extractProviderHttpStatus(message: string): number | undefined {
  const text = message.replace(/^(?:\[[^\]]+\]\s*)+/, '')
  const match = /^([1-5]\d\d)\b/.exec(text)
    ?? /\b(?:status(?: code)?|http)[:=]?\s*([1-5]\d\d)\b/i.exec(text)
    ?? /"(?:code|status)"\s*:\s*([1-5]\d\d)\b/.exec(text)
  return match ? Number(match[1]) : undefined
}
