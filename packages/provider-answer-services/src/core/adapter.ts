import {
  answerServiceRouteFamily,
  answerServiceRouteName,
  CompletionStatuses,
  deriveCitedDomains,
  describeError,
  escapeRegExp,
  finalizeLocationTreatment,
  IncompleteAnswerError,
  ProviderKinds,
  resolveLocationTreatment,
  routeSelection,
  type AnswerServiceDescriptor,
  type AnswerServiceProfile,
  type NormalizedQueryResult,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderHealthcheckResult,
  type RawQueryResult,
  type ResolvedProviderRoute,
  type TrackedQueryInput,
} from '@canonry/canonry-contracts'
import {
  AnswerServiceHttpError,
  AnswerServiceStreamError,
  requestJson,
  requestKeyCheck,
  requestStream,
  type AnswerServiceTransportOptions,
} from './http.js'
import {
  assembleEvidence,
  boundRawResponse,
  enforceAnswerPresent,
  enforceStreamCompletion,
  rawQueryResult,
} from './evidence.js'
import type { AnswerServiceDefinition, AnswerServiceStreamEnd, ParsedAnswer } from './types.js'

export interface AnswerServiceAdapterOptions {
  /** Injected for tests; production uses global fetch. */
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/** Refused before any request: the query is longer than the profile accepts. Never truncated. */
export class AnswerServiceQueryTooLongError extends Error {
  constructor(readonly service: string, readonly maxQueryChars: number, readonly queryChars: number) {
    super(`${service} accepts queries up to ${maxQueryChars} characters; this query has ${queryChars}. Shorten it or choose another engine.`)
    this.name = 'AnswerServiceQueryTooLongError'
  }
}

function profileOf(descriptor: AnswerServiceDescriptor, providerName: string): AnswerServiceProfile {
  const selection = routeSelection(providerName, answerServiceRouteFamily(descriptor))
  const profile = selection === undefined ? undefined : descriptor.profiles.find(item => item.id === selection)
  if (!profile) {
    throw new Error(`Select a ${descriptor.displayName} profile (${descriptor.profiles.map(item => answerServiceRouteName(descriptor.id, item.id)).join(', ')}); the connection alone is not an engine.`)
  }
  return profile
}

function configProblem(descriptor: AnswerServiceDescriptor, config: ProviderConfig): string | null {
  if (!config.apiKey?.trim()) return `Missing ${descriptor.displayName} API key`
  if (config.baseUrl) return `${descriptor.displayName} uses a fixed endpoint; remove the base URL`
  return null
}

function assertRouteModel(profile: AnswerServiceProfile, config: ProviderConfig): void {
  // The registry pins the route's profile as `model`; anything else is an override this service does not take.
  if (config.model !== undefined && config.model !== profile.id) {
    throw new Error(`Route profile "${profile.id}" cannot be overridden with "${config.model}".`)
  }
}

function incompleteMessage(descriptor: AnswerServiceDescriptor, parsed: ParsedAnswer): string {
  const { completion } = parsed
  switch (completion.status) {
    case CompletionStatuses.pending:
      return `${descriptor.displayName} returned a pending job (${completion.upstreamJobId}), not an answer.`
    case CompletionStatuses.partial:
      return `${descriptor.displayName} returned a partial answer${completion.error ? `: ${completion.error}` : ''}.`
    case CompletionStatuses.failed:
      return `${descriptor.displayName} reported a failure${completion.error ? `: ${completion.error}` : ''}.`
    case CompletionStatuses.complete:
      return `${descriptor.displayName} answer is complete.`
  }
}

/**
 * Build the provider adapter for one answer service. The connection adapter
 * (`<service>`) holds the key and quota and is never a measurement target;
 * `forRoute` returns the adapter each `<service>:<profile>` route runs as.
 */
export function createAnswerServiceAdapter(definition: AnswerServiceDefinition, options: AnswerServiceAdapterOptions = {}): ProviderAdapter {
  const { descriptor } = definition
  const family = answerServiceRouteFamily(descriptor)
  const profileIds = descriptor.profiles.map(profile => profile.id)
  const profilePattern = new RegExp(`^(?:${profileIds.map(escapeRegExp).join('|')})$`)

  const transport = (config: ProviderConfig, profile: AnswerServiceProfile): AnswerServiceTransportOptions => ({
    apiKey: config.apiKey ?? '',
    timeoutMs: profile.timeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  })

  async function execute(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    const profile = profileOf(descriptor, config.provider)
    assertRouteModel(profile, config)
    const problem = configProblem(descriptor, config)
    if (problem) throw new Error(problem)
    if (profile.execution === 'job') {
      throw new Error(`${descriptor.displayName} profile "${profile.id}" runs as an upstream job, which this release cannot run yet.`)
    }
    const maxQueryChars = profile.capabilities.maxQueryChars
    const queryChars = [...input.query].length
    if (maxQueryChars !== null && queryChars > maxQueryChars) {
      throw new AnswerServiceQueryTooLongError(descriptor.displayName, maxQueryChars, queryChars)
    }
    const offered = resolveLocationTreatment(input.location, profile.capabilities.location, profile.capabilities.location.serviceDefault ?? null)
    const built = definition.buildRequest({ query: input.query, profile, location: offered })
    const { request } = built
    // What the request carries decides the status, so a value the vendor cannot take is recorded as not sent.
    const location = finalizeLocationTreatment(offered, built.sentLocation)

    let parsed: ParsedAnswer
    let raw: Record<string, unknown>
    let bytes: number
    if (profile.transport === 'sse') {
      if (!definition.parseEvents || !definition.isTerminalEvent) throw new Error(`${descriptor.displayName} has no stream parser`)
      let events
      let ended: AnswerServiceStreamEnd
      let requestId: string | null
      try {
        const streamed = await requestStream(descriptor, request, transport(config, profile), definition.isTerminalEvent, definition.errorMessage)
        events = streamed.events
        ended = streamed.ended
        requestId = streamed.requestId
        bytes = streamed.bytes
      } catch (error) {
        if (!(error instanceof AnswerServiceStreamError)) throw error
        events = [...error.events]
        ended = 'aborted'
        requestId = error.requestId
        bytes = events.reduce((total, event) => total + event.data.length, 0)
      }
      parsed = enforceStreamCompletion(definition.parseEvents(events, { profile, headerRequestId: requestId, ended }), ended)
      raw = { events: events.map(event => ({ event: event.event, data: event.data })), ended }
    } else {
      if (!definition.parseResponse) throw new Error(`${descriptor.displayName} has no response parser`)
      const response = await requestJson(descriptor, request, transport(config, profile), definition.errorMessage)
      parsed = definition.parseResponse(response.body, { profile, headerRequestId: response.requestId })
      raw = response.body
      bytes = response.bytes
    }
    parsed = enforceAnswerPresent(parsed)
    const stored = boundRawResponse(raw, bytes)
    const evidence = assembleEvidence({ descriptor, profile, parsed, location, rawTruncated: stored.truncated })
    if (evidence.completion.status !== CompletionStatuses.complete) {
      // A synchronous request has no way to follow a pending handle, so it is never resumable here.
      throw new IncompleteAnswerError(incompleteMessage(descriptor, parsed), evidence, parsed.answerText, stored.raw, { resumable: false })
    }
    return rawQueryResult({ evidence, answerText: parsed.answerText ?? '', raw: stored.raw })
  }

  function normalize(raw: RawQueryResult): NormalizedQueryResult {
    const sources = raw.evidence?.sources ?? []
    return {
      provider: raw.provider,
      answerText: raw.answerText ?? '',
      citedDomains: raw.evidence ? deriveCitedDomains(sources) : [],
      groundingSources: raw.groundingSources,
      searchQueries: raw.searchQueries,
      retrievalStatus: raw.retrievalStatus,
      ...(raw.evidence ? { evidence: raw.evidence } : {}),
      citationMeasurable: raw.citationMeasurable ?? raw.evidence?.citationMeasurable ?? false,
    }
  }

  async function healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult> {
    const problem = configProblem(descriptor, config)
    if (problem) return { ok: false, provider: config.provider, message: problem }
    const keyCheck = descriptor.settings.keyCheck
    if (!keyCheck) {
      return { ok: true, provider: config.provider, message: `${descriptor.displayName} key saved, not verified: the service documents no free key check.` }
    }
    try {
      await requestKeyCheck(descriptor, { method: keyCheck.method, path: keyCheck.path }, {
        apiKey: config.apiKey ?? '',
        timeoutMs: 15_000,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
      })
      return { ok: true, provider: config.provider, message: `${descriptor.displayName} connected` }
    } catch (error) {
      return { ok: false, provider: config.provider, message: error instanceof AnswerServiceHttpError ? error.message : describeError(error) }
    }
  }

  function routeAdapter(route: ResolvedProviderRoute): ProviderAdapter {
    const profile = profileOf(descriptor, route.name)
    return {
      ...connection,
      name: route.name,
      displayName: `${profile.displayName} · ${descriptor.displayName}`,
      // Only a service that sends every requested field may claim the answer was measured from there.
      supportsLocationContext: profile.capabilities.location.granularity === 'full',
      capabilities: { textGeneration: false, groundedAnswer: true, workflows: [...profile.workflows] },
      modelRegistry: { ...connection.modelRegistry, defaultModel: profile.id },
    }
  }

  const connection: ProviderAdapter = {
    name: descriptor.id,
    displayName: descriptor.displayName,
    mode: 'api',
    kind: ProviderKinds['answer-service'],
    // The connection is never a target, so it runs no workflow; each route declares its profile's.
    capabilities: { textGeneration: false, groundedAnswer: true, workflows: [] },
    routes: family,
    defaultQuota: { ...descriptor.defaultQuota },
    supportsLocationContext: false,
    keyUrl: descriptor.keyUrl,
    modelRegistry: {
      defaultModel: '',
      knownModels: descriptor.profiles.map(profile => ({ id: profile.id, displayName: profile.displayName, tier: 'standard' as const })),
      validationPattern: profilePattern,
      validationHint: `one of the ${descriptor.displayName} profiles: ${profileIds.join(', ')}`,
    },
    forRoute: routeAdapter,
    validateConfig(config) {
      const problem = configProblem(descriptor, config)
      if (problem) return { ok: false, provider: config.provider, message: problem }
      return { ok: true, provider: config.provider, message: 'Configuration valid' }
    },
    healthcheck,
    executeTrackedQuery: execute,
    normalizeResult: normalize,
  }
  return connection
}
