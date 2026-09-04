import { complete, type Context, type Model } from '@mariozechner/pi-ai'
import {
  assertEngineRouteCanMeasure,
  engineConnectionModelCatalogResponseSchema,
  type EngineConnectionConfig,
  type EngineConnectionModelCatalogItem,
  type EngineConnectionModelCatalogResponse,
  type EngineRouteConfig,
  type NormalizedQueryResult,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderHealthcheckResult,
  type RawQueryResult,
  type TrackedQueryInput,
} from '@ainyc/canonry-contracts'
import { runEngineRouteText } from './engine-route-text-execution.js'

const MODEL_CATALOG_TIMEOUT_MS = 8_000
const MODEL_CATALOG_MAX_BYTES = 1_000_000
const MODEL_CATALOG_MAX_ITEMS = 500

/**
 * Build a pi-ai model for the generic OpenAI-compatible transport. This path
 * deliberately has no web-search/citation parser: it is for text work only.
 */
export function buildOpenAiCompatibleRouteModel(input: {
  connection: EngineConnectionConfig
  route: EngineRouteConfig
  config?: Pick<ProviderConfig, 'apiKey' | 'baseUrl' | 'model'>
}): Model<'openai-completions'> {
  const { connection, route, config } = input
  return {
    id: config?.model ?? route.modelId,
    name: route.label,
    api: 'openai-completions',
    provider: route.id,
    baseUrl: config?.baseUrl ?? connection.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 32_768,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  }
}

function textFromResponse(response: Awaited<ReturnType<typeof complete>>): string {
  return response.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim()
}

function unavailableModelCatalog(connectionId: string): EngineConnectionModelCatalogResponse {
  return engineConnectionModelCatalogResponseSchema.parse({
    connectionId,
    state: 'unavailable',
    manualModelIdAllowed: true,
    fetchedAt: new Date().toISOString(),
    models: [],
  })
}

async function boundedResponseText(response: Response): Promise<string | null> {
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > MODEL_CATALOG_MAX_BYTES) return null
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MODEL_CATALOG_MAX_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function normalizeModelCatalog(payload: unknown): EngineConnectionModelCatalogItem[] | null {
  const candidates = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null
  if (!candidates) return null

  const byId = new Map<string, EngineConnectionModelCatalogItem>()
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const row = candidate as Record<string, unknown>
    if (typeof row.id !== 'string' || !row.id.trim()) continue
    const id = row.id.trim()
    if (byId.has(id)) continue
    const displayName = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : undefined
    const provider = typeof row.owned_by === 'string' && row.owned_by.trim()
      ? row.owned_by.trim()
      : typeof row.provider === 'string' && row.provider.trim()
        ? row.provider.trim()
        : undefined
    byId.set(id, {
      id,
      ...(displayName ? { displayName } : {}),
      ...(provider ? { provider } : {}),
    })
  }
  return [...byId.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MODEL_CATALOG_MAX_ITEMS)
}

/**
 * Read the OpenAI-compatible `GET /models` catalog. This deliberately never
 * sends chat/completions payloads, follows no redirects with a credential,
 * bounds response memory, and returns an opaque typed fallback on any gateway
 * error so endpoint details and tokens never reach an API response.
 */
export async function fetchOpenAiCompatibleModelCatalog(
  connection: EngineConnectionConfig,
): Promise<EngineConnectionModelCatalogResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MODEL_CATALOG_TIMEOUT_MS)
  try {
    const response = await fetch(`${connection.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}),
      },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) return unavailableModelCatalog(connection.id)
    const text = await boundedResponseText(response)
    if (text === null) return unavailableModelCatalog(connection.id)
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return unavailableModelCatalog(connection.id)
    }
    const models = normalizeModelCatalog(payload)
    if (!models) return unavailableModelCatalog(connection.id)
    return engineConnectionModelCatalogResponseSchema.parse({
      connectionId: connection.id,
      state: 'available',
      manualModelIdAllowed: true,
      fetchedAt: new Date().toISOString(),
      models,
    })
  } catch {
    return unavailableModelCatalog(connection.id)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * A dynamic route can make internal text calls through pi-ai. `executeTrackedQuery`
 * intentionally refuses instead of returning an answer with invented empty evidence.
 */
export function createOpenAiCompatibleTextRouteAdapter(input: {
  connection: EngineConnectionConfig
  route: EngineRouteConfig
}): ProviderAdapter {
  const { connection, route } = input

  const validateConfig = (config: ProviderConfig): ProviderHealthcheckResult => {
    if (!config.baseUrl && !connection.baseUrl) {
      return { ok: false, provider: route.id, message: 'A baseUrl is required for an OpenAI-compatible route.' }
    }
    return { ok: true, provider: route.id, message: 'OpenAI-compatible text route configured.', model: config.model ?? route.modelId }
  }

  return {
    name: route.id,
    displayName: route.label,
    mode: 'api',
    // Generic transports cannot promise that a requested market reached the
    // answer engine. Never let a stored result make that claim.
    supportsLocationContext: false,
    modelRegistry: {
      defaultModel: route.modelId,
      validationPattern: /[\s\S]+/,
      validationHint: 'any non-empty model ID accepted by this connection',
      knownModels: [],
    },
    validateConfig,
    async healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult> {
      // A settings read/health presentation must not spend against a gateway.
      // The first text call is the operator-approved probe of this connection.
      return validateConfig(config)
    },
    async executeTrackedQuery(_query: TrackedQueryInput, _config: ProviderConfig): Promise<RawQueryResult> {
      assertEngineRouteCanMeasure(route)
      // `assertEngineRouteCanMeasure` always throws for configured generic
      // routes. Keep this impossible branch explicit so a future verified
      // adapter must supply real retrieval/citation extraction here.
      throw new Error(`Engine route "${route.id}" has no verified sweep adapter.`)
    },
    normalizeResult(_raw: RawQueryResult): NormalizedQueryResult {
      throw new Error(`Engine route "${route.id}" cannot normalize answer-visibility evidence without a verified adapter.`)
    },
    async generateText(prompt: string, config: ProviderConfig): Promise<string> {
      return runEngineRouteText(connection, async () => {
        const model = buildOpenAiCompatibleRouteModel({ connection, route, config })
        const context: Context = {
          messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        }
        const response = await complete(model, context, {
          ...(config.apiKey ?? connection.apiKey ? { apiKey: config.apiKey ?? connection.apiKey } : {}),
        })
        const text = textFromResponse(response)
        if (!text) throw new Error(`Engine route "${route.id}" returned no text content.`)
        return text
      })
    },
  }
}
