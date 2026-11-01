import {
  AgentJourneyCorrelationBases,
  agentJourneysQuerySchema,
  formatValidationIssues,
  type AgentJourney,
  type AgentJourneyContext,
  type AgentJourneysQuery,
} from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat, usageError } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

export type AgentJourneyCommandOptions = Omit<AgentJourneysQuery, 'trust'> & {
  trust?: string
  format?: string
}

function journeyQuery({ format: _format, ...selection }: AgentJourneyCommandOptions): AgentJourneysQuery {
  const parsed = agentJourneysQuerySchema.safeParse(selection)
  if (parsed.success) return parsed.data
  throw usageError(formatValidationIssues(parsed.error.issues), {
    details: { issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) },
  })
}

function printJourneyContext(context: AgentJourneyContext): void {
  const { scope, coverage } = context
  console.log(`Scope: ${scope.project} (${scope.mode}), source ${scope.sourceId ?? 'all'}, agent ${scope.agentId ?? 'all'}, trust ${scope.trust ?? 'all'}`)
  console.log(`Window: ${context.windowStart} to ${context.windowEnd}; sequences are bounded by this window.`)
  const revision = scope.planRevision === null ? '' : `, revision ${scope.planRevision}`
  console.log(`Property: ${scope.targetKey ?? 'all'}; attribution ${scope.attribution}${revision}`)
  console.log(`Unavailable dimensions: ${scope.unavailableDimensions.join(', ')}`)
  console.log(`Recording: ${coverage.recordingEnabled ? 'enabled' : 'disabled'}; retention ${coverage.retentionDays} days; inactivity gap ${coverage.idleMinutes} minutes; daily cap ${coverage.dailyEventLimit} events per source.`)
  for (const limitation of coverage.limitations) console.log(`Coverage: ${limitation}`)
  for (const source of coverage.sources) {
    for (const limitation of source.limitations) console.log(`Source ${source.sourceId} (${source.sourceType}): ${limitation}`)
  }
  for (const capped of coverage.cappedSourceDays) console.log(`Daily cap reached: ${capped.sourceId} on ${capped.day}`)
  if (coverage.likelyFakeRequests === null) console.log('Likely fake requests: not counted per Property (hourly totals carry no page path).')
  else if (coverage.likelyFakeRequests > 0) console.log(`Likely fake requests in this window (counted, not listed): ${coverage.likelyFakeRequests}`)
}

function printJourney(journey: AgentJourney): void {
  console.log(`${journey.id}  ${journey.product} (${journey.operator}, ${journey.agentId})  trust ${journey.trustLevels.join(', ')}`)
  console.log(`  ${journey.startedAt} to ${journey.endedAt}  ${journey.requestCount} requests, ${journey.errorCount} HTTP errors  source ${journey.sourceId}`)
  console.log(`  ${journey.firstHost ?? '(host unavailable)'}${journey.firstPath} → ${journey.lastPath}`)
  console.log(journey.correlationBasis === AgentJourneyCorrelationBases['ip-ua']
    ? '  Inferred sequence from IP and user agent; shared infrastructure can merge tasks.'
    : '  Unlinked request; no reliable request correlation is available.')
  if (journey.targetKeys.length > 0) console.log(`  Properties: ${journey.targetKeys.join(', ')}`)
}

export async function trafficAgentJourneys(project: string, opts: AgentJourneyCommandOptions): Promise<void> {
  const result = await createApiClient().trafficAgentJourneys(project, journeyQuery(opts))
  if (isMachineFormat(opts.format)) {
    if (opts.format === 'jsonl') {
      const { journeys, ...context } = result
      emitJsonl(journeys.map(journey => ({ ...context, journey })))
    } else console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Agent journeys: ${result.journeys.length} of ${result.totalJourneys}; ${result.observedRequests} recorded requests`)
  printJourneyContext(result)
  for (const journey of result.journeys) printJourney(journey)
  if (result.offset + result.journeys.length < result.totalJourneys) console.log(`More: --offset ${result.offset + result.journeys.length}`)
}

export async function trafficAgentJourney(project: string, journeyId: string, opts: AgentJourneyCommandOptions): Promise<void> {
  const result = await createApiClient().trafficAgentJourney(project, journeyId, journeyQuery(opts))
  if (isMachineFormat(opts.format)) {
    if (opts.format === 'jsonl') {
      const { events, ...context } = result
      emitJsonl(events.map(event => ({ ...context, event })))
    } else console.log(JSON.stringify(result, null, 2))
    return
  }
  printJourneyContext(result)
  printJourney(result.journey)
  console.log('Recorded requests; paths and HTTP status do not establish task success.')
  for (const event of result.events) {
    console.log(`  ${event.ts}  ${event.method ?? '-'}  ${event.status ?? '-'}  ${event.host ?? '(host unavailable)'}${event.path}  ${event.latencyMs === null ? '-' : `${event.latencyMs}ms`}  ${event.trust} (${event.trustReasons.join(', ')})  Property ${event.targetKey ?? '-'} (${event.attribution})`)
  }
  console.log(`Requests shown: ${result.events.length} of ${result.totalEvents}`)
  if (result.offset + result.events.length < result.totalEvents) console.log(`More: --offset ${result.offset + result.events.length}`)
}
