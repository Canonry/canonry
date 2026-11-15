import {
  asRecord,
  CompletionStatuses,
  SourceRelationships,
  unknownUsageObservation,
  type AnswerSource,
  type Completion,
  type UsageObservation,
} from '@canonry/canonry-contracts'
import type { AnswerServiceParseContext, ParsedAnswer } from '../../core/types.js'

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * The body is `{ code, message, data }`; the overview lives in
 * `data.result.content` and only `format: 'json'` carries it as an object.
 * Canonry always sends `output: 'json'`, so any other format is a failure
 * rather than text invented from Markdown or HTML.
 */
function contentOf(body: Record<string, unknown>): Record<string, unknown> | null {
  const data = asRecord(body.data)
  const result = asRecord(data?.result)
  const format = result?.format
  const content = asRecord(result?.content)
  if (!content || (format !== undefined && format !== 'json')) return null
  return content
}

/**
 * `results[].links[]` are the pages Google lists alongside the AI Overview it
 * wrote from them: answer support. The same link can repeat across results,
 * so repeats of one URL are collapsed to the first occurrence; order beyond
 * that is not documented as a ranking, so `rank` stays null. `title` and
 * `url` are the documented fields; everything else stays in the raw response.
 */
function sourcesOf(content: Record<string, unknown>): AnswerSource[] {
  const sources: AnswerSource[] = []
  const seen = new Set<string>()
  const results = Array.isArray(content.results) ? content.results : []
  for (const item of results) {
    const record = asRecord(item)
    const links = record && Array.isArray(record.links) ? record.links : []
    for (const link of links) {
      const entry = asRecord(link)
      const url = entry ? nonEmptyString(entry.url) : null
      if (!entry || !url || seen.has(url)) continue
      seen.add(url)
      sources.push({
        url,
        title: nonEmptyString(entry.title),
        relationship: SourceRelationships['answer-support'],
        rank: null,
        publishedAt: null,
        upstreamId: null,
      })
    }
  }
  return sources
}

/**
 * Money in credits: `costCredits` is what the request was charged, reported
 * verbatim as a billed unit. Cost stays unknown — credits are not USD and the
 * credit price depends on the pack bought, so no USD figure is derived here.
 */
function usageOf(costCredits: unknown): UsageObservation {
  const usage = unknownUsageObservation()
  if (typeof costCredits === 'number' && Number.isFinite(costCredits) && costCredits >= 0) {
    usage.billedUnits = [{ unit: 'credit', quantity: costCredits, basis: 'reported' }]
  }
  return usage
}

/**
 * A 200 response is the whole answer. `search_parameters.feature_available`
 * decides the shape: `true` with overview text is a complete answer, `false`
 * means Google showed no AI Overview for this query — a legitimate, billed
 * outcome with nothing to measure, so it is a failed query and never an
 * invented or empty text.
 */
export function parseGoanyapiAiOverview(body: Record<string, unknown>, context: AnswerServiceParseContext): ParsedAnswer {
  const content = contentOf(body)
  const overview = content === null ? null : overviewTextOf(content)
  const searchParameters = content === null ? null : asRecord(content.search_parameters)
  const featureAvailable = searchParameters?.feature_available

  let completion: Completion
  if (content === null) {
    completion = {
      status: CompletionStatuses.failed,
      finishReason: null,
      upstreamStatus: nonEmptyString(body.code),
      upstreamRequestId: context.headerRequestId,
      upstreamJobId: null,
      error: `GoAnyAPI returned a non-JSON result format; Canonry sends output=json only.`,
    }
  } else if (featureAvailable === false) {
    completion = {
      status: CompletionStatuses.failed,
      finishReason: null,
      upstreamStatus: 'feature_available:false',
      upstreamRequestId: context.headerRequestId,
      upstreamJobId: null,
      error: 'Google showed no AI Overview for this query (feature_available=false). GoAnyAPI still bills this request.',
    }
  } else {
    completion = {
      status: overview !== null ? CompletionStatuses.complete : CompletionStatuses.failed,
      finishReason: null,
      upstreamStatus: nonEmptyString(body.code),
      upstreamRequestId: context.headerRequestId,
      upstreamJobId: null,
      error: overview !== null ? null : 'The response carried no overview text.',
    }
  }
  return {
    answerText: overview,
    sources: content === null ? [] : sourcesOf(content),
    searchQueries: [],
    searchEventCount: 0,
    completion,
    usage: usageOf(asRecord(body.data)?.costCredits),
    disclosedModel: null,
  }
}

/** The overview text: the first result that carries one. */
function overviewTextOf(content: Record<string, unknown>): string | null {
  const results = Array.isArray(content.results) ? content.results : []
  for (const item of results) {
    const record = asRecord(item)
    const text = record ? nonEmptyString(record.text) : null
    if (text !== null) return text
  }
  return null
}

/** Plain explanations for the documented error codes an operator has to act on. */
const CODE_EXPLANATIONS: Readonly<Record<string, string>> = {
  insufficient_credits: 'The GoAnyAPI account is out of credits',
  invalid_params: 'GoAnyAPI rejected the parameters (a short-lived page_token is valid for one minute, and query caps at 8192 UTF-8 bytes)',
  request_failed: 'GoAnyAPI could not complete the upstream request',
  request_timeout: 'The upstream request timed out',
  service_not_configured: 'GoAnyAPI reports the service or its pricing as not configured',
}

/**
 * The error body is `{ code, message }` in the same envelope as a success.
 * The code set is open-ended, so an unknown code is kept as detail next to
 * the message.
 */
export function goanyapiErrorMessage(body: unknown): string | null {
  const record = asRecord(body)
  const code = record ? nonEmptyString(record.code) : null
  const message = record ? nonEmptyString(record.message) : null
  if (code === 'ok') return null
  const detail = message && code ? `${message} (${code})` : message ?? code
  const explanation = code ? CODE_EXPLANATIONS[code] : undefined
  if (explanation) return detail ? `${explanation}. GoAnyAPI said: ${detail}` : explanation
  return detail
}
