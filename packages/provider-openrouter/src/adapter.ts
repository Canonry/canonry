import {
  asRecord, describeError, hostOf, isRetryableHttpError, normalizeServedModel,
  openRouterRouteModel, openRouterRouteName, OPENROUTER_MODEL_PATTERN, OPENROUTER_ROUTE_FAMILY, ProviderKinds, registrableDomain, RetrievalContracts,
  RetrievalStatuses, retryAfterDelayMs, usageCount, withRetry,
  type GroundingSource, type ModelDefinition, type NormalizedQueryResult,
  type ProviderAdapter, type ProviderConfig, type RawQueryResult, type TrackedQueryInput,
  type TrackedQueryRequest,
} from '@canonry/canonry-contracts'

const BASE_URL = 'https://openrouter.ai/api/v1'
function modelOf(config: ProviderConfig): string {
  const routeModel = openRouterRouteModel(config.provider)
  if (routeModel && config.model && routeModel !== config.model) throw new Error('OpenRouter route model cannot be overridden')
  const model = routeModel ?? config.model
  if (!model || !openRouterRouteModel(`openrouter:${model}`)) throw new Error('Select a concrete OpenRouter text model (publisher/model)')
  return model
}

class OpenRouterHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter?: string) {
    super(`OpenRouter request failed (HTTP ${status})`)
    this.name = 'OpenRouterHttpError'
  }
}

/**
 * The HTTP status a failed choice stands for, or null when the answer finished.
 *
 * OpenRouter reports a provider failure that happens after headers were sent
 * as HTTP 200, with whatever text was produced, `finish_reason: "error"` and
 * an `error` object on the choice. That text is a cut-off answer: stored, it
 * would count as a full observation and, usually, as a miss in every mention
 * and citation rate. A failed choice is therefore a failed request, retried
 * like any other provider error.
 */
function choiceFailure(body: Record<string, unknown>): number | null {
  const choice = Array.isArray(body.choices) ? asRecord(body.choices[0]) : undefined
  const error = asRecord(choice?.error)
  if (!error && choice?.finish_reason !== 'error') return null
  return typeof error?.code === 'number' ? error.code : 502
}

async function fetchOnce(config: ProviderConfig, resource: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${(config.baseUrl || BASE_URL).replace(/\/+$/, '')}/${resource}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${config.apiKey ?? ''}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: signal ?? AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new OpenRouterHttpError(response.status, response.headers.get('retry-after') ?? undefined)
  const value = asRecord(await response.json())
  if (!value) throw new Error('OpenRouter returned an invalid response')
  const error = asRecord(value.error)
  if (error) throw new OpenRouterHttpError(typeof error.code === 'number' ? error.code : 502)
  const failed = choiceFailure(value)
  if (failed !== null) throw new OpenRouterHttpError(failed)
  return value
}

function request(config: ProviderConfig, resource: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return withRetry(() => fetchOnce(config, resource, body, signal), {
    isRetryable: error => !signal?.aborted && isRetryableHttpError(error),
    computeDelayMs: (_attempt, error, delay) => retryAfterDelayMs(error) ?? delay,
  })
}

function messageOf(body: Record<string, unknown>): Record<string, unknown> | null {
  const choice = Array.isArray(body.choices) ? asRecord(body.choices[0]) : undefined
  return asRecord(choice?.message)
}

function sourcesOf(body: Record<string, unknown>): GroundingSource[] {
  const annotations = messageOf(body)?.annotations
  const sources = new Map<string, GroundingSource>()
  if (!Array.isArray(annotations)) return []
  for (const value of annotations) {
    const annotation = asRecord(value)
    if (annotation?.type !== 'url_citation') continue
    const citation = asRecord(annotation.url_citation)
    if (typeof citation?.url !== 'string') continue
    let uri: string
    try { const url = new URL(citation.url); if (!['http:', 'https:'].includes(url.protocol)) continue; uri = url.href } catch { continue }
    if (!hostOf(uri)) continue
    sources.set(uri, { uri, title: typeof citation.title === 'string' ? citation.title : hostOf(uri)! })
  }
  return [...sources.values()]
}

function parseResponse(body: Record<string, unknown>, model: string, provider = openRouterRouteName(model)): RawQueryResult {
  // Also exported as parseTrackedQueryResponse, which never passes fetchOnce.
  const failed = choiceFailure(body)
  if (failed !== null) throw new OpenRouterHttpError(failed)
  const message = messageOf(body)
  if (typeof message?.content !== 'string' || !message.content.trim()) throw new Error('OpenRouter returned no answer text')
  const groundingSources = sourcesOf(body)
  const usage = asRecord(body.usage)
  const details = asRecord(usage?.input_tokens_details) ?? asRecord(usage?.prompt_tokens_details)
  const choice = Array.isArray(body.choices) ? asRecord(body.choices[0]) : undefined
  const cached = usageCount(details?.cached_tokens)
  const searchCount = usageCount(asRecord(usage?.server_tool_use)?.web_search_requests)
  const inputTokens = usage?.input_tokens === undefined ? usageCount(usage?.prompt_tokens) : usageCount(usage.input_tokens)
  const outputTokens = usage?.output_tokens === undefined ? usageCount(usage?.completion_tokens) : usageCount(usage.output_tokens)
  return {
    provider, model, servedModel: normalizeServedModel(body.model), rawResponse: body,
    groundingSources, searchQueries: [],
    retrievalContract: RetrievalContracts['search-required-v1'],
    retrievalStatus: searchCount > 0 || groundingSources.length ? RetrievalStatuses.used : RetrievalStatuses.unknown,
    ...(typeof choice?.finish_reason === 'string' ? { stopReason: choice.finish_reason } : {}),
    ...(usage ? { usage: {
      inputTokens: Math.max(0, inputTokens - cached), cachedInputTokens: cached,
      cacheWriteTokens: 0, outputTokens, searchCount,
    } } : {}),
  }
}

/** A catalog price (US dollars per token, as a decimal string) per million tokens. */
function perMillionTokens(value: unknown): number | undefined {
  if (typeof value === 'string' ? !value.trim() : typeof value !== 'number') return undefined
  const perToken = Number(value)
  // Routers publish -1 for a price that depends on the model they pick.
  if (!Number.isFinite(perToken) || perToken < 0) return undefined
  return Number((perToken * 1_000_000).toPrecision(12))
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * What Aero needs to call a model it has no bundled definition for, read from
 * the same `GET /models` entry. Sweeps ignore it; each field is left out when
 * the entry does not carry it.
 */
function catalogMetadata(model: Record<string, unknown>): Omit<ModelDefinition, 'id' | 'displayName' | 'tier'> {
  const topProvider = asRecord(model.top_provider)
  const pricing = asRecord(model.pricing)
  const input = perMillionTokens(pricing?.prompt)
  const output = perMillionTokens(pricing?.completion)
  const cacheRead = perMillionTokens(pricing?.input_cache_read)
  const cacheWrite = perMillionTokens(pricing?.input_cache_write)
  const modalities = asRecord(model.architecture)?.input_modalities
  const parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : undefined
  const contextWindow = positiveInteger(model.context_length) ?? positiveInteger(topProvider?.context_length)
  const maxOutputTokens = positiveInteger(topProvider?.max_completion_tokens)
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(input !== undefined && output !== undefined ? { pricing: {
      input, output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    } } : {}),
    ...(Array.isArray(modalities) ? { inputModalities: modalities.filter((entry): entry is string => typeof entry === 'string') } : {}),
    ...(parameters ? { supportsTools: parameters.includes('tools'), supportsReasoning: parameters.includes('reasoning') } : {}),
  }
}

function buildRequest(input: TrackedQueryInput, config: ProviderConfig): TrackedQueryRequest {
  const model = modelOf(config)
  return { endpoint: '/chat/completions', body: {
    model, messages: [{ role: 'user', content: input.query }], stream: false,
    tools: [{ type: 'openrouter:web_search', parameters: { max_uses: 1, max_total_results: 5 } }],
    tool_choice: 'required', max_tool_calls: 1, provider: { allow_fallbacks: false, require_parameters: true },
  } }
}

function normalize(raw: RawQueryResult): NormalizedQueryResult {
  const content = messageOf(raw.rawResponse)?.content
  return {
    provider: raw.provider, answerText: typeof content === 'string' ? content : '',
    citedDomains: [...new Set(raw.groundingSources.map(source => hostOf(source.uri)).filter((host): host is string => Boolean(host)).map(host => registrableDomain(host) ?? host))],
    groundingSources: raw.groundingSources, searchQueries: raw.searchQueries, retrievalStatus: raw.retrievalStatus,
  }
}

export const openrouterAdapter: ProviderAdapter = {
  name: 'openrouter',
  displayName: 'OpenRouter', mode: 'api', supportsLocationContext: false,
  // One connection, many pinned model routes; the bare connection is never a sweep target.
  kind: ProviderKinds['model-gateway'], routes: OPENROUTER_ROUTE_FAMILY,
  keyUrl: 'https://openrouter.ai/keys',
  modelRegistry: { defaultModel: '', validationPattern: OPENROUTER_MODEL_PATTERN, validationHint: 'a concrete text model ID, publisher/model', knownModels: [] },
  validateConfig(config) {
    if (!config.apiKey?.trim()) return { ok: false, provider: config.provider, message: 'Missing OpenRouter API key' }
    if (config.model || openRouterRouteModel(config.provider)) {
      try { modelOf(config) } catch (error) { return { ok: false, provider: config.provider, message: describeError(error) } }
    }
    return { ok: true, provider: config.provider, message: 'Configuration valid', model: config.model }
  },
  async healthcheck(config) {
    const valid = this.validateConfig(config)
    if (!valid.ok) return valid
    try { await request(config, 'auth/key'); return { ...valid, message: 'OpenRouter connected' } }
    catch (error) { return { ok: false, provider: config.provider, message: describeError(error) } }
  },
  async listModels(config, signal): Promise<ModelDefinition[]> {
    const body = await request(config, 'models', undefined, signal)
    if (!Array.isArray(body.data)) throw new Error('OpenRouter returned no model catalog')
    return body.data.flatMap(value => {
      const model = asRecord(value)
      if (typeof model?.id !== 'string' || !openRouterRouteModel(`openrouter:${model.id}`)) return []
      // A `:batch` variant is OpenRouter's batch routing for a model listed on
      // its own, not a separate model to answer sweeps.
      if (model.id.endsWith(':batch')) return []
      const architecture = asRecord(model.architecture)
      const output = architecture?.output_modalities
      // Sweeps need a text answer. A model that can also return images or audio
      // is an image, music or speech generator, not an answer engine.
      if (Array.isArray(output) && (!output.includes('text') || output.includes('image') || output.includes('audio'))) return []
      return [{ id: model.id, displayName: typeof model.name === 'string' ? model.name : model.id, tier: 'standard' as const, ...catalogMetadata(model) }]
    })
  },
  buildTrackedQueryRequest: buildRequest,
  parseTrackedQueryResponse: parseResponse,
  async executeTrackedQuery(input, config) {
    const built = buildRequest(input, config)
    return parseResponse(await request(config, 'chat/completions', built.body), modelOf(config), config.provider)
  },
  normalizeResult: normalize,
  async generateText(prompt, config) {
    const response = await request(config, 'chat/completions', { model: modelOf(config), messages: [{ role: 'user', content: prompt }], provider: { allow_fallbacks: false }, stream: false })
    const content = messageOf(response)?.content
    if (typeof content !== 'string') throw new Error('OpenRouter returned no text')
    return content
  },
}
