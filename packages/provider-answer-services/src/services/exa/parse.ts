import {
  asRecord,
  CompletionStatuses,
  CostBases,
  SourceRelationships,
  unknownUsageObservation,
  usdToMicros,
  type AnswerSource,
  type Completion,
  type UsageObservation,
} from '@canonry/canonry-contracts'
import type { AnswerServiceParseContext, ParsedAnswer } from '../../core/types.js'

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * `citations[]` are "search results used to generate the answer": each one is
 * answer support. Author, image, favicon and text stay in the raw response.
 * Non-web URLs are kept as returned; the shared layer counts only http(s)
 * sources as cited.
 */
function sourcesOf(citations: unknown): AnswerSource[] {
  if (!Array.isArray(citations)) return []
  const sources: AnswerSource[] = []
  for (const item of citations) {
    const citation = asRecord(item)
    const url = nonEmptyString(citation?.url)
    if (!citation || !url) continue
    sources.push({
      url,
      title: nonEmptyString(citation.title),
      relationship: SourceRelationships['answer-support'],
      // The list order is not documented as a ranking.
      rank: null,
      publishedAt: nonEmptyString(citation.publishedDate),
      upstreamId: nonEmptyString(citation.id),
    })
  }
  return sources
}

/** Only money is reported, as an estimate. Tokens, searches and page reads stay unknown. */
function usageOf(costDollars: unknown): UsageObservation {
  const usage = unknownUsageObservation()
  const micros = usdToMicros(asRecord(costDollars)?.total)
  if (micros !== null) usage.cost = { micros, currency: 'USD', basis: CostBases.estimated, estimatedBy: 'provider' }
  return usage
}

const STRUCTURED_ANSWER_ERROR = 'Exa returned a structured answer. Canonry sends no output schema and measures text answers only.'

/**
 * A 200 response is the whole answer: Exa documents no partial or pending
 * state for a non-streamed request. A text answer is complete (the shared
 * layer fails an empty one); anything else is a failure, never text made up
 * from a structured object.
 */
export function parseExaAnswer(body: Record<string, unknown>, context: AnswerServiceParseContext): ParsedAnswer {
  const answerText = typeof body.answer === 'string' ? body.answer : null
  const completion: Completion = {
    status: answerText === null ? CompletionStatuses.failed : CompletionStatuses.complete,
    finishReason: null,
    upstreamStatus: null,
    upstreamRequestId: nonEmptyString(body.requestId) ?? context.headerRequestId,
    upstreamJobId: null,
    error: answerText !== null ? null : asRecord(body.answer) ? STRUCTURED_ANSWER_ERROR : 'The response carried no answer.',
  }
  return {
    answerText,
    sources: sourcesOf(body.citations),
    searchQueries: [],
    searchEventCount: 0,
    completion,
    usage: usageOf(body.costDollars),
    disclosedModel: null,
  }
}

/** Plain explanations for the documented tags an operator has to act on. */
const TAG_EXPLANATIONS: Readonly<Record<string, string>> = {
  INVALID_API_KEY: 'The Exa API key is missing or invalid',
  NO_MORE_CREDITS: 'The Exa account is out of credits',
  API_KEY_BUDGET_EXCEEDED: 'This Exa key is over its spending budget',
  TEAM_BUDGET_EXCEEDED: 'The Exa team is over its spending budget',
  FEATURE_DISABLED: 'The Exa plan does not include this feature',
}

/**
 * The error body is `{ requestId, error, tag }`. The tag set is open-ended, so
 * an unknown tag is kept as detail next to the message.
 */
export function exaErrorMessage(body: unknown): string | null {
  const record = asRecord(body)
  const message = nonEmptyString(record?.error)
  const tag = nonEmptyString(record?.tag)
  const detail = message && tag ? `${message} (${tag})` : message ?? tag
  const explanation = tag ? TAG_EXPLANATIONS[tag] : undefined
  if (explanation) return detail ? `${explanation}. Exa said: ${detail}` : explanation
  return detail
}
