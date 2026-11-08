import type { FastifyInstance, FastifyRequest } from 'fastify'
import type {
  AnswerServiceProfileSummary,
  ProviderCapabilities,
  ProviderCatalogEntryDto,
  ProviderKeyCheck,
  ProviderKind,
  ProviderModelRegistry,
  ProviderQuotaPolicy,
  ProviderReloadRequest,
  ProviderRouteFamily,
  ProviderSettingsField,
  ProviderConnectionConfigDto,
  ProviderConnectionSettingsDto,
  ProviderConnectionTestResultDto,
  ProviderDisconnectRequest,
  ProviderHealthcheckResult,
  ProviderSettingsUpdateRequest,
  SettingsDto,
} from '@canonry/canonry-contracts'
import {
  AppError,
  describeError,
  validationError,
  notImplemented,
  internalError,
  OutcomeReasonCodes,
  OutcomeStatuses,
  providerConnectionTestResultDtoSchema,
  ProviderConnectionTestErrorReasons,
  ProviderConnectionTestStatuses,
  providerReloadRequestSchema,
  providerReloadResponseDtoSchema,
  redactLogString,
  ProviderKinds,
  providerRouteName,
  routeFamiliesOf,
  notFound,
  operationInProgress,
  providerConnectionConfigDtoSchema,
  providerConnectionSettingsDtoSchema,
  ProviderConnectionsUnavailableReasons,
  providerConnectionsUnavailableReasonSchema,
  providerDisconnectRequestSchema,
  providerSettingsUpdateRequestSchema,
  providerSummaryEntryDtoSchema,
  ProviderNames,
} from '@canonry/canonry-contracts'
import { isInstanceAdministrator, requireAdminSession, requireInstanceAdministrator, requirePaidReadScope, requireScope } from './auth.js'
import { auditFromRequest, type AuditEntry } from './helpers.js'
import { connectionRoute, outcomeProviderName } from './connection-telemetry.js'
import { withFeatureOutcome } from './feature-outcome.js'
import { providerAdapterForName } from './provider-models.js'
import { providerConnectionSettings } from './provider-settings-usage.js'

/**
 * Scope required to mutate any global setting — provider API keys,
 * Google OAuth client credentials, Bing API key, CDP endpoint.
 *
 * Without this gate any caller with any valid bearer token could swap the
 * operator's OpenAI/Anthropic/Gemini/Perplexity keys for an attacker's
 * (siphoning quota), or swap the Google OAuth client secret to harvest
 * future OAuth grants. The default key written by `canonry init` carries
 * `scopes: ['*']` which satisfies this gate by wildcard; future
 * delegate-key flows must opt in explicitly.
 */
export const SETTINGS_WRITE_SCOPE = 'settings.write'

export interface ProviderSummaryEntry {
  name: string
  displayName?: string
  keyUrl?: string
  modelHint?: string
  model?: string
  /** The adapter's built-in default model (used when `model` is unset). */
  defaultModel?: string
  configured: boolean
  quota?: ProviderQuotaPolicy
  /** Whether Vertex AI is configured for this provider (Gemini only) */
  vertexConfigured?: boolean
  /** Absent means an answer engine. */
  kind?: ProviderKind
}

export interface GoogleSettingsSummary {
  configured: boolean
}

export interface BingSettingsSummary {
  configured: boolean
}

export interface ProviderAdapterInfo {
  name: string
  displayName: string
  mode: 'api' | 'browser'
  /** Browser/detected models are visible but cannot be overridden per project. */
  modelConfigurable: boolean
  defaultModel: string
  knownModels: ProviderModelRegistry['knownModels']
  modelValidationPattern: RegExp
  modelValidationHint: string
  /** Absent means an answer engine. */
  kind?: ProviderKind
  capabilities?: ProviderCapabilities
  /** The route family a connection serves; its bare name is then never a target. */
  routes?: ProviderRouteFamily
  /** Answer-service profiles, from the service descriptor. */
  profiles?: AnswerServiceProfileSummary[]
  settingsFields?: ProviderSettingsField[]
  keyCheck?: ProviderKeyCheck
  keyUrl?: string
  vendorDocsUrl?: string
}

/**
 * The catalog fields an adapter description adds beyond the model registry.
 * Only adapters that declare them gain them, so every answer engine's catalog
 * entry keeps its exact shape.
 */
function descriptorFields(adapter: ProviderAdapterInfo): Partial<ProviderCatalogEntryDto> {
  if (!adapter.kind && !adapter.routes && !adapter.profiles) return {}
  return {
    ...(adapter.kind ? { kind: adapter.kind } : {}),
    connection: adapter.routes?.connection ?? adapter.name,
    selectionKind: adapter.routes?.selectionKind ?? null,
    ...(adapter.profiles ? { profiles: adapter.profiles } : {}),
    ...(adapter.capabilities?.workflows ? { workflows: [...adapter.capabilities.workflows] } : {}),
    ...(adapter.capabilities ? { textGeneration: adapter.capabilities.textGeneration } : {}),
    ...(adapter.settingsFields ? { settingsFields: adapter.settingsFields } : {}),
    ...(adapter.keyCheck ? { keyCheck: adapter.keyCheck } : {}),
    ...(adapter.keyUrl ? { keyUrl: adapter.keyUrl } : {}),
    ...(adapter.vendorDocsUrl ? { vendorDocsUrl: adapter.vendorDocsUrl } : {}),
  }
}

export interface SettingsRoutesOptions {
  /** Every known connection, including disconnected ones. Stored and credential-free; never calls providers. */
  getProviderConnections?: () => ProviderConnectionConfigDto[]
  onProviderSettingsUpdate?: (name: string, input: ProviderSettingsUpdateRequest, auditContext?: Pick<AuditEntry, 'actor' | 'userAgent' | 'actorSession' | 'requestId' | 'credentialId'>) => ProviderSummaryEntry | Promise<ProviderSummaryEntry>
  onProviderDisconnect?: (name: string, expectedRevision: string | undefined, auditContext?: Pick<AuditEntry, 'actor' | 'userAgent' | 'actorSession' | 'requestId' | 'credentialId'>) => void | Promise<void>
  /** Cached, credential-free model metadata supplied by the execution host. */
  getProviderModels?: (name: string) => Promise<ProviderModelRegistry['knownModels']>
  providerSummary?: ProviderSummaryEntry[]
  /** Adapter metadata for validation — keyed by provider name */
  providerAdapters?: ProviderAdapterInfo[]
  onProviderUpdate?: (provider: string, apiKey: string, model?: string, baseUrl?: string, quota?: Partial<ProviderQuotaPolicy>, auditContext?: Pick<AuditEntry, 'actor' | 'userAgent' | 'actorSession' | 'requestId' | 'credentialId'>) => ProviderSummaryEntry | null
  /** Reload only this host's captured provider configuration; never select caller paths. */
  onProviderReload?: (input: ProviderReloadRequest, auditContext?: Pick<AuditEntry, 'actor' | 'userAgent' | 'actorSession' | 'requestId' | 'credentialId'>) => ProviderSummaryEntry[] | Promise<ProviderSummaryEntry[]>
  /**
   * Run one saved connection's own healthcheck now, a live provider call.
   * Resolves undefined when the connection is not configured on this host.
   * Once `signal` aborts (the route stopped waiting), the check must send
   * nothing more: pass it on to the adapter's healthcheck.
   */
  onProviderTest?: (name: string, signal: AbortSignal) => Promise<ProviderHealthcheckResult | undefined>
  /** How long a connection test waits for the host's check. Defaults to `PROVIDER_TEST_TIMEOUT_MS`. */
  providerTestTimeoutMs?: number
  google?: GoogleSettingsSummary
  onGoogleUpdate?: (clientId: string, clientSecret: string) => GoogleSettingsSummary | null
  bing?: BingSettingsSummary
  onBingUpdate?: (apiKey: string) => BingSettingsSummary | null
}

/**
 * How long a connection test waits for the host's check before reporting it
 * failed. Healthchecks retry throttles and network errors, so a refused
 * endpoint can take several seconds; an unreachable one would otherwise hang.
 */
export const PROVIDER_TEST_TIMEOUT_MS = 30_000

type ProviderTestCheck =
  | { kind: 'checked'; check: ProviderHealthcheckResult }
  | { kind: 'not-configured' }
  | { kind: 'timed-out' }

/**
 * The host's check, bounded by `timeoutMs`. When the route stops waiting, the
 * check's signal aborts, so its retries stop instead of spending on in the
 * background. A late answer is dropped: a check changes nothing on the server.
 */
async function runProviderTest(test: NonNullable<SettingsRoutesOptions['onProviderTest']>, name: string, timeoutMs: number): Promise<ProviderTestCheck> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ProviderTestCheck>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timed-out' }), timeoutMs)
    timer.unref()
  })
  const check = Promise.resolve().then(() => test(name, controller.signal)).then((result): ProviderTestCheck => (
    result ? { kind: 'checked', check: result } : { kind: 'not-configured' }
  ))
  try {
    return await Promise.race([check, timeout])
  } catch (error) {
    // A deliberate refusal from the host keeps its status; anything else is this provider's failure.
    if (error instanceof AppError) throw error
    return { kind: 'checked', check: { ok: false, provider: name, message: describeError(error) } }
  } finally {
    clearTimeout(timer)
    // Whatever the outcome, nothing of this test keeps running once the route answers.
    controller.abort(new Error(`The ${name} connection test is over.`))
  }
}

function secondsLabel(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsRoutesOptions) {
  const connections = (): ProviderConnectionSettingsDto[] => {
    if (!opts.getProviderConnections) throw notImplemented('Provider connection details are not supported in this deployment')
    const configured = opts.getProviderConnections().map(value => providerConnectionConfigDtoSchema.parse(value))
    return providerConnectionSettings(app.db, configured, opts.providerAdapters ?? []).map(value => providerConnectionSettingsDtoSchema.parse(value))
  }
  const connection = (name: string): ProviderConnectionSettingsDto => {
    const found = connections().find(value => value.name === name)
    if (!found) throw notFound('Provider connection', name)
    return found
  }
  // The connection list reads the host's saved configuration and every
  // project's saved selections. When it cannot be built, the rest of the
  // settings (provider status, catalog, Google, Bing) must still answer.
  const connectionState = (request: FastifyRequest): Pick<SettingsDto, 'providerConnections' | 'providerConnectionsUnavailable'> => {
    if (!opts.getProviderConnections || !isInstanceAdministrator(request)) return {}
    try {
      return { providerConnections: connections() }
    } catch (error) {
      // A host refusal names its reason and a message written without secrets or paths.
      if (error instanceof AppError) {
        const reason = providerConnectionsUnavailableReasonSchema.safeParse(error.details?.reason)
        if (reason.success) return { providerConnectionsUnavailable: { reason: reason.data, message: error.message } }
      }
      // Anything else may quote stored values, so only the server log sees it.
      request.log.error({ err: error }, 'Provider connections could not be listed')
      return { providerConnectionsUnavailable: {
        reason: ProviderConnectionsUnavailableReasons['internal-error'],
        message: 'Provider connections could not be loaded. Check the server log, then retry.',
      } }
    }
  }
  // Settings describe which credentials this install holds and where its
  // providers point. That is administrator territory even to read, so a
  // view-only account is refused here at the server rather than merely being
  // shown no link to it.
  app.get('/settings', async (request) => {
    requireAdminSession(request)
    return {
      providers: opts.providerSummary ?? [],
      ...connectionState(request),
      providerCatalog: (await Promise.all((opts.providerAdapters ?? []).map(async adapter => {
        const configured = opts.providerSummary?.some(provider => provider.name === adapter.name && provider.configured)
        const discovered = configured && opts.getProviderModels ? await opts.getProviderModels(adapter.name) : []
        const knownModels = discovered.length ? discovered : adapter.knownModels
        const descriptor = {
          name: adapter.name,
          displayName: adapter.displayName,
          mode: adapter.mode,
          modelConfigurable: adapter.modelConfigurable,
          defaultModel: adapter.defaultModel,
          // Catalog entries can carry Aero's model metadata (limits, prices,
          // tool support); the documented choice shape is id, name and tier.
          knownModels: knownModels.map(({ id, displayName, tier }) => ({ id, displayName, tier })),
          modelValidationPattern: {
            source: adapter.modelValidationPattern.source,
            flags: adapter.modelValidationPattern.flags,
          },
          modelValidationHint: adapter.modelValidationHint,
          ...descriptorFields(adapter),
        }
        // Descriptions that predate `routes` (the Cloud catalog) still know OpenRouter.
        const family = routeFamiliesOf(opts.providerAdapters).find(item => item.connection === adapter.name)
        if (!family) return [descriptor]
        // A routed connection lists one entry per route it can serve: each
        // catalog model of a gateway, each declared profile of an answer service.
        const selections = family.selectionKind === 'profile'
          ? (adapter.profiles ?? []).map(profile => profile.id)
          : knownModels.map(model => model.id)
        const routeAdapters = selections.flatMap(selection => {
          let routeName: string
          try { routeName = providerRouteName(family, selection) } catch { return [] }
          const route = providerAdapterForName(routeName, [{ ...adapter, knownModels }])
          if (!route) return []
          const fields = descriptorFields(route)
          return [{
            ...descriptor,
            ...fields,
            name: route.name,
            displayName: route.displayName,
            modelConfigurable: false,
            defaultModel: route.defaultModel,
            knownModels: route.knownModels,
            modelValidationPattern: { source: route.modelValidationPattern.source, flags: route.modelValidationPattern.flags },
            modelValidationHint: route.modelValidationHint,
            // A route is a target, not a connection: it selects nothing further and holds no key.
            ...(Object.keys(fields).length > 0 ? { selectionKind: null, settingsFields: undefined, keyCheck: undefined } : {}),
          }]
        })
        return [descriptor, ...routeAdapters]
      }))).flat(),
      google: opts.google ?? { configured: false },
      bing: opts.bing ?? { configured: false },
    }
  })

  app.get<{ Params: { name: string } }>('/settings/providers/:name', async request => {
    requireInstanceAdministrator(request)
    return connection(request.params.name)
  })

  app.delete<{ Params: { name: string }; Body: ProviderDisconnectRequest }>('/settings/providers/:name', async request => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    requireInstanceAdministrator(request)
    const parsed = providerDisconnectRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw validationError('Invalid provider disconnect request', parsed.error.flatten())
    if (!opts.onProviderDisconnect) throw notImplemented('Provider disconnection is not supported in this deployment')
    const current = connection(request.params.name)
    if (!current.capabilities.disconnect) throw notImplemented('This provider connection is managed by the host and cannot be disconnected here')
    const expected = parsed.data.expectedImpactRevision
    if (expected !== undefined && expected !== current.impactRevision) {
      throw operationInProgress('Provider settings or usage changed. Review the current connection before disconnecting.', { reason: 'provider-impact-changed' })
    }
    const { actor, userAgent, actorSession, requestId, credentialId } = auditFromRequest(request, { actor: 'api', action: 'provider.disconnected', entityType: 'provider' })
    await opts.onProviderDisconnect(current.name, expected === undefined ? undefined : current.revision, { actor, userAgent, actorSession, requestId, credentialId })
    return connection(current.name)
  })

  app.put<{
    Params: { name: string }
    Body: ProviderSettingsUpdateRequest
  }>('/settings/providers/:name', connectionRoute(app, (request) => {
    // A key or endpoint is a connection; a model or quota change alone is not.
    const provider = outcomeProviderName(request.params.name)
    const body = request.body as { apiKey?: unknown; baseUrl?: unknown } | undefined
    if (!provider || (body?.apiKey === undefined && body?.baseUrl === undefined)) return undefined
    const configured = (opts.providerSummary ?? []).some(entry => entry.name === provider && entry.configured)
    return { integration: 'provider', provider, action: configured ? 'reauth' : 'connect' }
  }, async (request) => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    const parsed = providerSettingsUpdateRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw validationError('Invalid provider settings', parsed.error.flatten())
    const { apiKey, baseUrl, model, quota, reset, expectedRevision } = parsed.data
    if (reset) requireInstanceAdministrator(request)
    const name = request.params.name

    const adapters = opts.providerAdapters ?? []
    const apiAdapters = adapters.filter(a => a.mode === 'api' || opts.onProviderSettingsUpdate !== undefined)
    const adapterInfo = apiAdapters.find(a => a.name === name)
    if (!adapterInfo) {
      const validNames = apiAdapters.map(a => a.name)
      throw validationError(`Invalid provider: ${name}. Must be one of: ${validNames.join(', ')}`, {
        provider: name,
        validProviders: validNames,
      })
    }

    const existing = (opts.providerSummary ?? []).find(provider => provider.name === name)
    const configured = Boolean(existing?.configured)
    if (adapterInfo.mode === 'browser') {
      if (apiKey !== undefined || baseUrl !== undefined || model !== undefined || reset?.model || reset?.apiKey || reset?.baseUrl) {
        throw validationError('Browser endpoint changes use /settings/cdp; only request limits can be changed here')
      }
    } else if (!configured && name === 'local') {
      if (!baseUrl) {
        throw validationError('baseUrl is required for local provider')
      }
    } else if (!configured && name === 'gemini' && !apiKey) {
      const geminiSummary = (opts.providerSummary ?? []).find(p => p.name === 'gemini')
      if (!geminiSummary?.vertexConfigured) {
        throw validationError(
          'apiKey is required for Gemini unless Vertex AI is configured ' +
          '(set GEMINI_VERTEX_PROJECT env var or vertexProject in config file)',
        )
      }
    } else if (!configured) {
      if (!apiKey || typeof apiKey !== 'string') {
        throw validationError('apiKey is required')
      }
    }

    // An answer service takes a key and nothing else: its endpoint is fixed
    // (so the key can never be sent elsewhere) and each route pins its profile.
    if (adapterInfo.kind === ProviderKinds['answer-service']) {
      if (baseUrl !== undefined) throw validationError(`${adapterInfo.displayName} uses a fixed endpoint; baseUrl is not accepted.`, { provider: name })
      if (reset?.baseUrl) throw validationError(`${adapterInfo.displayName} uses a fixed endpoint and has no endpoint override to reset.`, { provider: name })
      if (model !== undefined) throw validationError(`${adapterInfo.displayName} has no connection model; choose profiles per project instead.`, { provider: name })
      if (reset?.model) throw validationError(`${adapterInfo.displayName} has no connection model to reset.`, { provider: name })
    }
    if (reset?.apiKey && name !== ProviderNames.local) throw validationError('Only the optional local-provider API key can be cleared; disconnect other providers instead')
    if (reset?.baseUrl && name === ProviderNames.local) throw validationError('A local provider requires an endpoint; disconnect it to remove the endpoint')

    if (model !== undefined) {
      adapterInfo.modelValidationPattern.lastIndex = 0
      if (!adapterInfo.modelValidationPattern.test(model)) {
        throw validationError(
          `Invalid model "${model}" for provider "${name}" — ${adapterInfo.modelValidationHint}`,
        )
      }
    }

    if (!opts.onProviderSettingsUpdate && (!opts.onProviderUpdate || reset || expectedRevision !== undefined)) {
      throw notImplemented('Provider configuration updates are not supported in this deployment')
    }

    // Only trusted identity and bounded correlation reach the host's audit writer;
    // never forward the authorization header or mutable request object.
    const { actor, userAgent, actorSession, requestId, credentialId } = auditFromRequest(request, {
      actor: 'api', action: 'provider.updated', entityType: 'provider',
    })
    const context = { actor, userAgent, actorSession, requestId, credentialId }
    const result = opts.onProviderSettingsUpdate
      ? await opts.onProviderSettingsUpdate(name, parsed.data, context)
      : opts.onProviderUpdate!(name, apiKey ?? '', model, baseUrl, quota, context)
    if (!result) {
      throw internalError('Failed to update provider configuration')
    }

    return providerSummaryEntryDtoSchema.parse(result)
  }))

  app.post('/settings/providers/reload', async (request) => withFeatureOutcome(app, { feature: 'providers', operation: 'reload' }, async (settle) => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    requireInstanceAdministrator(request)
    const parsed = providerReloadRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError('Invalid provider reload request', parsed.error.flatten())
    }
    if (!opts.onProviderReload) {
      throw notImplemented('Provider configuration reload is not supported in this deployment')
    }
    const { actor, userAgent, actorSession, requestId, credentialId } = auditFromRequest(request, {
      actor: 'api', action: 'providers.reloaded', entityType: 'provider',
    })
    const providers = await opts.onProviderReload(parsed.data, { actor, userAgent, actorSession, requestId, credentialId })
    settle({ status: OutcomeStatuses.succeeded, counts: { providers: providers.filter(provider => provider.configured).length } })
    return providerReloadResponseDtoSchema.parse({ reloaded: true, providers })
  }, err => (err instanceof AppError && err.code === 'NOT_IMPLEMENTED' ? OutcomeReasonCodes.UNSUPPORTED : undefined)))

  // Connections with a test still running on this server: a repeat click waits
  // for that result instead of stacking another check on the same quota.
  const testsInFlight = new Set<string>()

  // A POST because it calls the provider now; it reads and changes no saved state.
  app.post<{ Params: { name: string } }>('/settings/providers/:name/test', async (request) => withFeatureOutcome(app, { feature: 'providers', operation: 'test' }, async (settle): Promise<ProviderConnectionTestResultDto> => {
    // The check spends on the operator's install-wide provider account with
    // the saved key, so only an install administrator runs it, as with the
    // connection's detail, reload and disconnect: never a viewer, a read-only
    // key, a key scoped to something else, or a key confined to one project.
    requireAdminSession(request)
    requirePaidReadScope(request, [SETTINGS_WRITE_SCOPE], `Testing a provider connection calls the provider with its saved key, which requires the "${SETTINGS_WRITE_SCOPE}" scope on your API key.`)
    requireInstanceAdministrator(request)
    const name = request.params.name
    const adapters = opts.providerAdapters ?? []
    const adapter = adapters.find(item => item.name === name)
    if (!adapter) {
      const validNames = adapters.map(item => item.name)
      throw validationError(`Invalid provider: ${name}. Must be one of: ${validNames.join(', ')}`, { provider: name, validProviders: validNames })
    }
    if (!opts.onProviderTest) throw notImplemented('Provider connection tests are not supported in this deployment')
    if (testsInFlight.has(name)) {
      throw operationInProgress(`A ${adapter.displayName} connection test is already running. Wait for its result, then test again.`, {
        provider: name,
        reason: ProviderConnectionTestErrorReasons['provider-test-in-progress'],
      })
    }

    const startedAt = Date.now()
    const timeoutMs = opts.providerTestTimeoutMs ?? PROVIDER_TEST_TIMEOUT_MS
    testsInFlight.add(name)
    let outcome: ProviderTestCheck
    try {
      outcome = await runProviderTest(opts.onProviderTest, name, timeoutMs)
    } finally {
      testsInFlight.delete(name)
    }
    if (outcome.kind === 'not-configured') {
      throw validationError(`${adapter.displayName} is not configured. Save its connection, then test it.`, {
        provider: name,
        reason: ProviderConnectionTestErrorReasons['provider-not-configured'],
      })
    }
    const check: ProviderHealthcheckResult = outcome.kind === 'checked'
      ? outcome.check
      : { ok: false, provider: name, message: `${adapter.displayName} did not answer within ${secondsLabel(timeoutMs)}. Check the endpoint and network, then test again.` }
    const status = !check.ok
      ? ProviderConnectionTestStatuses.failed
      : check.verified === false ? ProviderConnectionTestStatuses['not-verified'] : ProviderConnectionTestStatuses.connected

    const provider = outcomeProviderName(name)
    switch (status) {
      case ProviderConnectionTestStatuses.connected:
        settle({ status: OutcomeStatuses.succeeded, ...(provider ? { provider } : {}) })
        break
      case ProviderConnectionTestStatuses['not-verified']:
        settle({ status: OutcomeStatuses.skipped, reasonCode: OutcomeReasonCodes.UNSUPPORTED, ...(provider ? { provider } : {}) })
        break
      case ProviderConnectionTestStatuses.failed:
        settle({ status: OutcomeStatuses.failed, reasonCode: outcome.kind === 'timed-out' ? OutcomeReasonCodes.TIMEOUT : OutcomeReasonCodes.UNKNOWN, ...(provider ? { provider } : {}) })
        break
      default: {
        const _exhaustive: never = status
        return _exhaustive
      }
    }
    return providerConnectionTestResultDtoSchema.parse({
      provider: name,
      displayName: adapter.displayName,
      status,
      ok: status !== ProviderConnectionTestStatuses.failed,
      // Provider errors can quote a key fragment or an Authorization header.
      message: redactLogString(check.message),
      model: check.model ?? null,
      checkedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
    })
  }, err => (err instanceof AppError && err.code === 'NOT_IMPLEMENTED' ? OutcomeReasonCodes.UNSUPPORTED : undefined)))

  app.put<{
    Body: { clientId?: string; clientSecret?: string }
  }>('/settings/google', async (request) => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    const { clientId, clientSecret } = request.body ?? {}

    if (!clientId || typeof clientId !== 'string' || !clientSecret || typeof clientSecret !== 'string') {
      throw validationError('clientId and clientSecret are required')
    }

    if (!opts.onGoogleUpdate) {
      throw notImplemented('Google OAuth configuration updates are not supported in this deployment')
    }

    const result = opts.onGoogleUpdate(clientId, clientSecret)
    if (!result) {
      throw internalError('Failed to update Google OAuth configuration')
    }

    return result
  })

  app.put<{
    Body: { apiKey?: string }
  }>('/settings/bing', async (request) => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    const { apiKey } = request.body ?? {}

    if (!apiKey || typeof apiKey !== 'string') {
      throw validationError('apiKey is required')
    }

    if (!opts.onBingUpdate) {
      throw notImplemented('Bing configuration updates are not supported in this deployment')
    }

    const result = opts.onBingUpdate(apiKey)
    if (!result) {
      throw internalError('Failed to update Bing configuration')
    }

    return result
  })
}
