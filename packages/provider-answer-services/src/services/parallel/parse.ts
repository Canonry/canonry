import {
  asRecord,
  CompletionStatuses,
  SourceRelationships,
  unknownUsageObservation,
  type AnswerSource,
  type AnswerSourceSpan,
  type Completion,
  type UsageObservation,
} from '@canonry/canonry-contracts'
import type { AnswerServiceParseContext, ParsedAnswer } from '../../core/types.js'

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
}

/**
 * The `message` items that carry the answer. A message whose `phase` is
 * `commentary` is an interim note, not the answer, and stays in the raw
 * response only.
 */
function answerMessages(output: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return output.filter(item => item.type === 'message' && item.phase !== 'commentary')
}

interface AnswerRead {
  text: string | null
  citations: AnswerSource[]
}

/**
 * Join the `output_text` parts in order (parts directly, messages with a blank
 * line) and turn every `url_citation` annotation into an explicit citation.
 * Annotations for the same URL become one source with every span it supports;
 * several URLs on one span each keep that span. Offsets are Parallel's,
 * shifted by the length of any earlier text so they point into the stored
 * answer (with the documented single text part they are unchanged).
 */
function readAnswer(messages: readonly Record<string, unknown>[]): AnswerRead {
  const byUrl = new Map<string, { title: string | null; spans: AnswerSourceSpan[] }>()
  let text: string | null = null
  for (const message of messages) {
    let messageStarted = false
    for (const part of records(message.content)) {
      if (part.type !== 'output_text' || typeof part.text !== 'string') continue
      if (text === null) text = ''
      else if (!messageStarted) text += '\n\n'
      messageStarted = true
      const offset = text.length
      text += part.text
      for (const annotation of records(part.annotations)) {
        const url = nonEmptyString(annotation.url)
        if (annotation.type !== 'url_citation' || !url) continue
        const cited = byUrl.get(url) ?? { title: null, spans: [] }
        byUrl.set(url, cited)
        cited.title ??= nonEmptyString(annotation.title)
        const start = count(annotation.start_index)
        const end = count(annotation.end_index)
        if (start === null || end === null || end < start) continue
        if (!cited.spans.some(span => span.start === offset + start && span.end === offset + end)) {
          cited.spans.push({ start: offset + start, end: offset + end, basis: 'upstream' })
        }
      }
    }
  }
  // Annotation order is not documented as a ranking, and annotations carry no id or date.
  const citations = [...byUrl].map(([url, cited]): AnswerSource => ({
    url,
    title: cited.title,
    relationship: SourceRelationships['explicit-citation'],
    rank: null,
    spans: cited.spans,
    publishedAt: null,
    upstreamId: null,
  }))
  return { text, citations }
}

interface SearchTrail {
  pageReads: AnswerSource[]
  pageReadCount: number
  searchQueries: string[]
  searchCount: number
}

/**
 * `web_search_call` items: one per search the model ran or page it read.
 * A `search` contributes its `queries` (or `query` when that is all there
 * is); `action.sources` is documented as always null. An `open_page` is a page
 * read, kept once per item because reading a page twice produces two items,
 * with the item's own status. MCP items are not read.
 */
function readSearchTrail(output: readonly Record<string, unknown>[]): SearchTrail {
  const trail: SearchTrail = { pageReads: [], pageReadCount: 0, searchQueries: [], searchCount: 0 }
  for (const item of output) {
    if (item.type !== 'web_search_call') continue
    const action = asRecord(item.action)
    if (action?.type === 'search') {
      trail.searchCount++
      const queries = Array.isArray(action.queries) ? action.queries.map(nonEmptyString).filter((query): query is string => query !== null) : []
      const single = nonEmptyString(action.query)
      trail.searchQueries.push(...(queries.length > 0 ? queries : single ? [single] : []))
    } else if (action?.type === 'open_page') {
      trail.pageReadCount++
      const url = nonEmptyString(action.url)
      if (!url) continue
      trail.pageReads.push({
        url,
        title: null,
        relationship: SourceRelationships['page-read'],
        rank: null,
        publishedAt: null,
        upstreamId: nonEmptyString(item.id),
        status: nonEmptyString(item.status),
      })
    }
  }
  return trail
}

/** The answer messages' status: `completed` only when every one completed, otherwise the first that did not. */
function messageStatus(messages: readonly Record<string, unknown>[]): string | null {
  if (messages.length === 0) return null
  const unfinished = messages.find(message => message.status !== 'completed')
  return unfinished ? nonEmptyString(unfinished.status) ?? 'missing a status' : 'completed'
}

function failureMessage(error: unknown): string {
  const record = asRecord(error)
  const message = nonEmptyString(record?.message)
  const code = nonEmptyString(record?.code)
  if (message && code) return `${message} (${code})`
  return message ?? code ?? 'Parallel reported a failure without a message.'
}

/**
 * Map the documented response `status` (and, when it is absent, the answer
 * message's `status`) onto the shared completion. Only a completed response
 * with a completed answer message is complete. `queued` and `in_progress`
 * keep the response id as the pending handle: the Responses API is
 * synchronous and documents no way to fetch it later, so it is recorded and
 * never read as an answer.
 */
function completionOf(body: Record<string, unknown>, messages: readonly Record<string, unknown>[], context: AnswerServiceParseContext): Completion {
  const status = nonEmptyString(body.status)
  const id = nonEmptyString(body.id)
  const base: Completion = {
    status: CompletionStatuses.failed,
    finishReason: null,
    upstreamStatus: status,
    upstreamRequestId: id ?? context.headerRequestId,
    upstreamJobId: null,
    error: null,
  }
  const answerStatus = messageStatus(messages)
  switch (status) {
    case 'completed':
      if (answerStatus === null) return { ...base, error: 'Parallel returned no answer message.' }
      if (answerStatus !== 'completed') return { ...base, status: CompletionStatuses.partial, error: `The answer message is ${answerStatus}, although the response is completed.` }
      return { ...base, status: CompletionStatuses.complete }
    case 'incomplete': {
      const reason = nonEmptyString(asRecord(body.incomplete_details)?.reason)
      return { ...base, status: CompletionStatuses.partial, finishReason: reason, error: `Parallel stopped before the answer was finished (${reason ?? 'no reason given'}).` }
    }
    case 'failed':
      return { ...base, error: failureMessage(body.error) }
    case 'cancelled':
      return { ...base, error: 'Parallel cancelled the response.' }
    case 'queued':
    case 'in_progress':
      if (!id) return { ...base, error: `Parallel returned an unfinished response (${status}) without an id.` }
      return { ...base, status: CompletionStatuses.pending, upstreamJobId: id, error: `Parallel had not finished (${status}). The Responses API offers no way to fetch the answer later.` }
    case null:
      if (answerStatus === 'completed') return { ...base, status: CompletionStatuses.complete }
      if (answerStatus === 'incomplete') return { ...base, status: CompletionStatuses.partial, error: 'The answer message is incomplete.' }
      return { ...base, error: 'The response carried no status and no completed answer message.' }
    default:
      return { ...base, error: `Parallel returned an unrecognized status "${status}".` }
  }
}

/**
 * Token counts are documented as approximate (Parallel bills per request, not
 * per token) and the response carries no cost. Searches and page reads are
 * counted from the trail; a complete response shows every one, so zero is
 * known there and unknown otherwise.
 */
function usageOf(body: Record<string, unknown>, trail: SearchTrail, complete: boolean): UsageObservation {
  const usage = unknownUsageObservation()
  const reported = asRecord(body.usage)
  if (reported) {
    const input = count(reported.input_tokens)
    const output = count(reported.output_tokens)
    const reasoning = count(asRecord(reported.output_tokens_details)?.reasoning_tokens)
    if (input !== null || output !== null || reasoning !== null) usage.tokens = { input, output, reasoning, basis: 'approximate' }
  }
  if (complete || trail.searchCount > 0) usage.searches = { count: trail.searchCount, basis: 'derived-from-evidence' }
  if (complete || trail.pageReadCount > 0) usage.pageReads = { count: trail.pageReadCount, basis: 'derived-from-evidence' }
  return usage
}

/**
 * Read the `output` array by item type rather than any `output_text`
 * convenience accessor. Citations are explicit citations, page reads stay page
 * reads, and searches are events; none of them stands in for another. The
 * response `model` is kept verbatim as a service tier, never a served model.
 */
export function parseParallelResponse(body: Record<string, unknown>, context: AnswerServiceParseContext): ParsedAnswer {
  const output = records(body.output)
  const messages = answerMessages(output)
  const answer = readAnswer(messages)
  const trail = readSearchTrail(output)
  const completion = completionOf(body, messages, context)
  return {
    answerText: answer.text,
    sources: [...answer.citations, ...trail.pageReads],
    searchQueries: trail.searchQueries,
    searchEventCount: trail.searchCount,
    completion,
    usage: usageOf(body, trail, completion.status === CompletionStatuses.complete),
    disclosedModel: nonEmptyString(body.model),
  }
}

/**
 * Error bodies use the OpenAI envelope `{ error: { message, type, param, code } }`
 * (Parallel's general format `{ error: { message, detail } }` has the same
 * `message`), and validation failures `{ detail: [{ loc, msg, type }] }`.
 */
export function parallelErrorMessage(body: unknown): string | null {
  const record = asRecord(body)
  if (!record) return null
  const error = asRecord(record.error)
  if (error) {
    const message = nonEmptyString(error.message)
    const kind = [nonEmptyString(error.type), nonEmptyString(error.code)].filter((value): value is string => value !== null)
    if (message && kind.length > 0) return `${message} (${kind.join(', ')})`
    return message ?? (kind.length > 0 ? kind.join(', ') : null)
  }
  if (Array.isArray(record.detail)) {
    const problems = records(record.detail).map(item => {
      const message = nonEmptyString(item.msg)
      const where = Array.isArray(item.loc) ? item.loc.filter(part => typeof part === 'string' || typeof part === 'number').join('.') : ''
      return message && where ? `${where}: ${message}` : message
    }).filter((problem): problem is string => problem !== null)
    return problems.length > 0 ? problems.join('; ') : null
  }
  return nonEmptyString(record.error) ?? nonEmptyString(record.detail)
}
