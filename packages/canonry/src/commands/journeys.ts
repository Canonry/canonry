import {
  formatValidationIssues,
  journeySummaryQuerySchema,
  journeysQuerySchema,
  type JourneyEntryClass,
  type JourneyVisitDto,
} from '@canonry/canonry-contracts'
import type { z } from 'zod'
import { createApiClient } from '../client.js'
import { isMachineFormat, usageError } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

export interface JourneyWindowOptions {
  since?: string
  until?: string
  format?: string
}

export interface JourneyListOptions extends JourneyWindowOptions {
  engine?: string
  returned?: boolean
  limit?: number
  offset?: number
}

function parse<S extends z.ZodType>(schema: S, input: Record<string, unknown>): z.infer<S> {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  throw usageError(formatValidationIssues(parsed.error.issues), {
    details: { issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) },
  })
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

const minute = (ts: string) => `${ts.slice(0, 16).replace('T', ' ')}Z`
const day = (ts: string) => ts.slice(0, 10)

function entryLabel(visit: Pick<JourneyVisitDto, 'entryClass' | 'entryName' | 'paid'>): string {
  const name = visit.entryName && visit.entryName !== visit.entryClass ? ` ${visit.entryName}` : ''
  return `${visit.entryClass}${name}${visit.paid && visit.entryClass !== 'paid' ? ' (paid)' : ''}`
}

const UA_NOTE = 'Visitors keyed by user agent only (sources without an IP, such as Vercel) can merge different people on the same device and browser version.'

export async function journeysSummary(project: string, opts: JourneyWindowOptions): Promise<void> {
  const query = parse(journeySummaryQuerySchema, compact({ since: opts.since, until: opts.until }))
  const result = await createApiClient().journeysSummary(project, query)
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`AI visitor journeys for "${project}", first AI visit ${day(result.windowStart)} to ${day(result.windowEnd)}`)
  console.log(`AI visitors: ${result.aiVisitors} (IP and user agent ${result.keyBasis.ipUa}, user agent only ${result.keyBasis.ua})`)
  console.log(`AI visits: ${result.aiVisits}`)
  const rate = result.returnRate === null ? '-' : `${Math.round(result.returnRate * 100)}%`
  const median = result.medianDaysToReturn === null ? '' : `, median ${result.medianDaysToReturn.toFixed(1)} days to return`
  console.log(`Came back later: ${result.returningVisitors} (${rate})${median}`)
  const via = (Object.entries(result.returnedVia) as [JourneyEntryClass, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  if (via.length > 0) console.log(`Later visits by entry: ${via.map(([cls, n]) => `${cls} ${n}`).join(', ')}`)
  for (const row of result.byEngine) console.log(`  ${row.engine}: ${row.visitors} visitors, ${row.returningVisitors} came back`)
  console.log(`Stored for ${result.lookbackDays} days after each visitor's latest AI visit. ${result.keyBasis.ua > 0 ? UA_NOTE : ''}`.trim())
}

export async function journeysList(project: string, opts: JourneyListOptions): Promise<void> {
  const query = parse(journeysQuerySchema, compact({
    since: opts.since,
    until: opts.until,
    engine: opts.engine,
    returned: opts.returned === undefined ? undefined : String(opts.returned),
    limit: opts.limit,
    offset: opts.offset,
  }))
  const result = await createApiClient().journeysList(project, query)
  if (isMachineFormat(opts.format)) {
    if (opts.format === 'jsonl') emitJsonl(result.visitors.map(visitor => ({ project, windowStart: result.windowStart, windowEnd: result.windowEnd, ...visitor })))
    else console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`AI visitors for "${project}": ${result.visitors.length} of ${result.totalVisitors}, first AI visit ${day(result.windowStart)} to ${day(result.windowEnd)}`)
  for (const visitor of result.visitors) {
    const back = visitor.returned ? `back via ${visitor.returnChannels.join(', ')}` : 'no later visit'
    console.log([minute(visitor.firstAiAt), visitor.firstAiEngine, visitor.device, `${visitor.visitCount} visits`, back, visitor.visitorKey].join('  '))
  }
  if (result.offset + result.visitors.length < result.totalVisitors) {
    console.log(`More: --offset ${result.offset + result.visitors.length}`)
  }
}

export async function journeyShow(project: string, visitorKey: string, opts: { format?: string }): Promise<void> {
  const result = await createApiClient().journeyGet(project, visitorKey)
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const { visitor } = result
  console.log(`Visitor ${visitor.visitorKey} (${visitor.keyBasis === 'ua' ? 'user agent only' : 'IP and user agent'})`)
  console.log(`Device: ${visitor.device}`)
  console.log(`User agent: ${visitor.userAgent ?? '-'}`)
  console.log(`First AI visit: ${minute(visitor.firstAiAt)} from ${visitor.firstAiEngine}. Latest AI visit: ${minute(visitor.lastAiAt)}. Last seen: ${minute(visitor.lastSeenAt)}`)
  for (const visit of result.visits) {
    console.log('')
    console.log(`${minute(visit.startedAt)} to ${minute(visit.endedAt)}  ${entryLabel(visit)}  lands ${visit.landingPath}  ${visit.pageCount} pages, ${visit.requestCount} requests`)
    for (const event of visit.events) {
      console.log(`  ${event.ts.slice(11, 19)}  ${event.method ?? '-'}  ${event.status ?? '-'}  ${event.kind === 'data' ? '[data] ' : ''}${event.path}`)
    }
  }
  if (visitor.keyBasis === 'ua') console.log(`\n${UA_NOTE}`)
}
