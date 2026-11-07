import {
  asRecord,
  CompletionStatuses,
  SourceRelationships,
  unknownUsageObservation,
  type AnswerSource,
  type Completion,
  type SourceRelationship,
} from '@canonry/canonry-contracts'
import type { AnswerServiceParseContext, ParsedAnswer } from '../../core/types.js'

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
}

/**
 * One source per URL. `citationPills` has one entry per (pill, source) pair,
 * so a URL cited by several pills appears more than once; the first non-empty
 * `label` is kept. Pill ids, positions, domains and descriptions stay in the
 * raw response. List order is display order, not a documented ranking.
 */
function sourcesOf(items: unknown, relationship: SourceRelationship): AnswerSource[] {
  const byUrl = new Map<string, AnswerSource>()
  for (const item of records(items)) {
    const url = nonEmptyString(item.url)
    if (!url) continue
    const existing = byUrl.get(url)
    if (existing) {
      existing.title ??= nonEmptyString(item.label)
      continue
    }
    byUrl.set(url, {
      url,
      title: nonEmptyString(item.label),
      relationship,
      rank: null,
      // Only ChatGPT sends `datePublished`, verbatim (an ISO date on pills, a display date on sources).
      publishedAt: nonEmptyString(item.datePublished),
      upstreamId: null,
    })
  }
  return [...byUrl.values()]
}

/**
 * A 200 response carries the whole answer: cloro charges only for a 200 and
 * reports every failure with an HTTP error status. `result.text` is the
 * answer. Inline `citationPills` are explicit citations; `sources` are the
 * pages the surface shows for the answer, kept as answer support. Only
 * ChatGPT names a model (`result.model`, empty on its mobile-web format).
 * The response reports no tokens, search queries or cost.
 */
export function parseCloroMonitorResponse(body: Record<string, unknown>, context: AnswerServiceParseContext): ParsedAnswer {
  const result = asRecord(body.result) ?? {}
  const answerText = typeof result.text === 'string' ? result.text : null
  const failure = body.success === false
    ? 'cloro reported success: false.'
    : answerText === null ? 'The response carried no answer text.' : null
  const completion: Completion = {
    status: failure ? CompletionStatuses.failed : CompletionStatuses.complete,
    finishReason: null,
    upstreamStatus: null,
    upstreamRequestId: context.headerRequestId,
    upstreamJobId: null,
    error: failure,
  }
  return {
    answerText,
    sources: [
      ...sourcesOf(result.citationPills, SourceRelationships['explicit-citation']),
      ...sourcesOf(result.sources, SourceRelationships['answer-support']),
    ],
    // Gemini and AI Mode return no query fan-out. ChatGPT returns it only
    // with the paid `include.searchQueries`, which is not sent.
    searchQueries: [],
    searchEventCount: 0,
    completion,
    usage: unknownUsageObservation(),
    disclosedModel: context.profile.id === 'chatgpt' ? nonEmptyString(result.model) : null,
  }
}

/** Plain explanations for the documented codes an operator has to act on. */
const CODE_EXPLANATIONS: Readonly<Record<string, string>> = {
  MISSING_API_KEY: 'The cloro API key is missing or invalid',
  INVALID_API_KEY_FORMAT: 'The cloro API key is missing or invalid',
  INVALID_OR_EXPIRED_API_KEY: 'The cloro API key is missing or invalid',
  INSUFFICIENT_CREDITS: 'The cloro account is out of credits',
}

/**
 * Every error uses `{ success: false, error: { code, message, details, timestamp } }`.
 * On a validation error, `details` lists each failing field.
 */
export function cloroErrorMessage(body: unknown): string | null {
  const error = asRecord(asRecord(body)?.error)
  if (!error) return null
  const message = nonEmptyString(error.message)
  const code = nonEmptyString(error.code)
  const fields = records(error.details)
    .map(item => [nonEmptyString(item.field), nonEmptyString(item.message)].filter((part): part is string => part !== null).join(': '))
    .filter(Boolean)
  const text = [message, fields.length > 0 ? fields.join('; ') : null].filter((part): part is string => part !== null).join(': ')
  const detail = text && code ? `${text} (${code})` : text || code
  const explanation = code ? CODE_EXPLANATIONS[code] : undefined
  if (explanation) return detail ? `${explanation}. cloro said: ${detail}` : explanation
  return detail
}
