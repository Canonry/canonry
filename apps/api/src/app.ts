import Fastify from 'fastify'
import crypto from 'node:crypto'

import type { PlatformEnv } from '@ainyc/canonry-config'
import { createClient } from '@ainyc/canonry-db'
import { apiRoutes, resolveTrustProxy } from '@ainyc/canonry-api-routes'
import {
  buildImplicitNativeEngineRoute,
  canonicalEngineRoutePolicyJson,
  type EngineRouteCapabilities,
  type MeasurementExecutionRouteDescriptor,
} from '@ainyc/canonry-contracts'

import { registerHealthRoutes } from './routes/health.js'
import { registerTelemetryCollectorRoutes } from './routes/telemetry-collector.js'

// Keep this explicit instead of inferring from the provider catalog. The cloud
// catalog includes compatibility providers for settings validation, but only
// these server-owned adapters have the evidence contract required to describe
// a route as measurement-ready.
const CLOUD_VERIFIED_MEASUREMENT_PROVIDER_NAMES = new Set([
  'gemini',
  'openai',
  'claude',
  'perplexity',
])

const cloudVerifiedNativeCapabilities: EngineRouteCapabilities = {
  kind: 'verified-measurement',
  retrieval: true,
  citations: true,
  location: true,
  servedModel: true,
  fallback: 'disabled',
}

const cloudTextOnlyCapabilities: EngineRouteCapabilities = { kind: 'text-only' }

/** Never infer measurement proof from a configured/cloud-known provider name. */
export function cloudEngineRouteCapabilities(providerName: string): EngineRouteCapabilities {
  return CLOUD_VERIFIED_MEASUREMENT_PROVIDER_NAMES.has(providerName)
    ? cloudVerifiedNativeCapabilities
    : cloudTextOnlyCapabilities
}

export function buildApp(env: PlatformEnv) {
  // A cloud deployment is always behind at least one load balancer, so the
  // socket's peer is never the caller. Anything keyed on `request.ip` — the
  // sign-in budget in particular — is meaningless until this says which hops
  // to believe. See `resolveTrustProxy`.
  //
  // Leaving CANONRY_TRUST_PROXY unset does NOT mean "no proxy" here the way it
  // safely does for a standalone `canonry serve` — this app only ever runs
  // behind a load balancer, so an unset value silently makes every caller
  // resolve to that load balancer's own address, and every per-caller
  // rate-limit / login budget collapses into one shared bucket that punishes
  // every real caller for one attacker. That degradation must be an explicit
  // operator decision, not a silent default, so refuse to start instead.
  const rawTrustProxy = process.env.CANONRY_TRUST_PROXY
  if (rawTrustProxy === undefined) {
    throw new Error(
      'CANONRY_TRUST_PROXY is not set. This deployment always sits behind a load balancer, so '
      + 'leaving it unset makes every caller resolve to the load balancer\'s own address and '
      + 'collapses every per-caller rate limit / login budget into one shared bucket. Set it to the '
      + 'trusted hop count (e.g. "1") or a comma-separated proxy CIDR list, or explicitly to "false" '
      + 'only if this deployment is truly reachable directly with nothing in front of it.',
    )
  }
  const trustProxy = resolveTrustProxy(rawTrustProxy)
  const app = Fastify({
    logger: true,
    trustProxy,
  })

  // Connect to database and register shared API routes
  const db = createClient(env.databaseUrl)

  const providerSummary = (['gemini', 'openai', 'claude', 'perplexity'] as const).map(name => ({
    name,
    model: env.providers[name]?.model,
    configured: !!env.providers[name],
    quota: env.providers[name]?.quota,
  }))
  // Cloud validates the same public model-id conventions as local serve
  // without importing execution adapters (and their provider SDK graphs).
  //
  // This list is not only a catalog: `apiRoutes` fans its NAMES out as the
  // provider allowlist for project, query, run, apply, and schedule writes. A
  // missing entry is therefore not a cosmetic gap — the provider stops being
  // writable on Cloud while local `canonry serve` still accepts it. It must
  // name EVERY registered adapter (`API_ADAPTERS` + `BROWSER_ADAPTERS` in
  // packages/canonry/src/server.ts), which is what `PROVIDER_NAMES` in
  // contracts enumerates; `app.test.ts` pins that invariant.
  //
  // KEEP IN SYNC with each adapter's `modelRegistry` in
  // packages/provider-*/src/adapter.ts (defaultModel / knownModels /
  // validationPattern / validationHint). This is a deliberate hand-mirrored copy
  // because apps/api must not pull the provider SDK graphs; a stale copy makes
  // the cloud /settings catalog advertise a wrong "inherited default" and a
  // truncated model list versus what the worker actually runs. Durable fix
  // (deferred): move each registry into an SDK-free module shared by the adapter
  // and this list so they cannot drift.
  const providerAdapters = [
    {
      name: 'gemini', displayName: 'Gemini', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'gemini-2.5-flash',
      knownModels: [
        { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', tier: 'flagship' as const },
        { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', tier: 'standard' as const },
        { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', tier: 'economy' as const },
        { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', tier: 'standard' as const },
      ],
      modelValidationPattern: /./,
      modelValidationHint: 'any valid Google model name (e.g. gemini-2.5-flash, learnlm-1.5-pro-experimental)',
    },
    {
      name: 'openai', displayName: 'OpenAI', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'gpt-5.4',
      knownModels: [
        { id: 'gpt-5.4', displayName: 'GPT-5.4', tier: 'flagship' as const },
        { id: 'gpt-5.4-pro', displayName: 'GPT-5.4 Pro', tier: 'flagship' as const },
        { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', tier: 'fast' as const },
        { id: 'gpt-5-nano', displayName: 'GPT-5 Nano', tier: 'economy' as const },
        { id: 'gpt-5', displayName: 'GPT-5', tier: 'standard' as const },
        { id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'standard' as const },
      ],
      modelValidationPattern: /./,
      modelValidationHint: 'any valid OpenAI model name (e.g. gpt-5.4, o3, chatgpt-4o-latest)',
    },
    {
      name: 'claude', displayName: 'Claude', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'claude-sonnet-4-6',
      knownModels: [
        { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', tier: 'flagship' as const },
        { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', tier: 'standard' as const },
        { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', tier: 'fast' as const },
      ],
      modelValidationPattern: /^claude-/,
      modelValidationHint: 'model name must start with "claude-" (e.g. claude-sonnet-4-6)',
    },
    {
      name: 'perplexity', displayName: 'Perplexity', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'sonar',
      knownModels: [
        { id: 'sonar', displayName: 'Sonar', tier: 'standard' as const },
        { id: 'sonar-pro', displayName: 'Sonar Pro', tier: 'flagship' as const },
        { id: 'sonar-reasoning', displayName: 'Sonar Reasoning', tier: 'flagship' as const },
        { id: 'sonar-reasoning-pro', displayName: 'Sonar Reasoning Pro', tier: 'flagship' as const },
      ],
      modelValidationPattern: /^sonar/,
      modelValidationHint: 'expected a sonar model (e.g. sonar, sonar-pro, sonar-reasoning)',
    },
    {
      name: 'local', displayName: 'Local', mode: 'api' as const, modelConfigurable: true,
      defaultModel: 'llama3',
      knownModels: [
        { id: 'llama3', displayName: 'Llama 3', tier: 'standard' as const },
      ],
      modelValidationPattern: /./,
      modelValidationHint: 'any model name accepted',
    },
    {
      // Browser adapter — the model is detected from the ChatGPT web UI, so it
      // is visible in the catalog but not project-overridable (mode !== 'api').
      name: 'cdp:chatgpt', displayName: 'ChatGPT (Browser)', mode: 'browser' as const, modelConfigurable: false,
      defaultModel: 'chatgpt-web',
      knownModels: [
        { id: 'chatgpt-web', displayName: 'ChatGPT (Web UI)', tier: 'standard' as const },
      ],
      modelValidationPattern: /./,
      modelValidationHint: 'model is detected from the ChatGPT web UI',
    },
  ]

  // The model each configured provider will actually answer with: its
  // explicit env override if set, else the hand-mirrored catalog's own
  // default (KEEP IN SYNC comment above). A plan-pinned run freezes this at
  // queue time via `getEffectiveProviderModels`, so an inherited default that
  // is empty here silently drops the model half of that run's execution
  // identity on Cloud while local `canonry serve` still records it.
  const effectiveProviderModels = (): Record<string, string> => {
    const models: Record<string, string> = {}
    for (const provider of providerSummary) {
      if (!provider.configured) continue
      const defaultModel = providerAdapters.find(adapter => adapter.name === provider.name)?.defaultModel
      const model = provider.model ?? defaultModel
      if (model) models[provider.name] = model
    }
    return models
  }

  const providerRouteDescriptors = (): Record<string, MeasurementExecutionRouteDescriptor> => {
    const descriptors: Record<string, MeasurementExecutionRouteDescriptor> = {}
    for (const provider of providerSummary) {
      if (!provider.configured) continue
      const adapter = providerAdapters.find(candidate => candidate.name === provider.name)
      if (!adapter) continue
      const route = buildImplicitNativeEngineRoute({
        provider: provider.name,
        displayName: adapter.displayName,
        defaultModel: effectiveProviderModels()[provider.name] ?? adapter.defaultModel,
        capabilities: cloudEngineRouteCapabilities(provider.name),
      })
      descriptors[provider.name] = {
        routeId: route.id,
        routeRevision: route.revision,
        policyFingerprint: crypto.createHash('sha256')
          .update(canonicalEngineRoutePolicyJson(route))
          .digest('hex'),
      }
    }
    return descriptors
  }

  app.register(apiRoutes, {
    db,
    skipAuth: false,
    routePrefix: env.basePath === '/' ? '/api/v1' : `${env.basePath.replace(/\/$/, '')}/api/v1`,
    openApiInfo: {
      title: 'Canonry API',
      version: '0.1.0',
    },
    providerSummary,
    providerAdapters,
    getRunnableProviderNames: () =>
      providerSummary.filter(provider => provider.configured).map(provider => provider.name),
    getEffectiveProviderModels: effectiveProviderModels,
    getProviderRouteDescriptors: providerRouteDescriptors,
    googleStateSecret: env.googleStateSecret,
    trustProxyConfigured: trustProxy !== false,
  })

  // NO MCP TRANSPORT AND NO OAUTH HERE, deliberately.
  //
  // The MCP server lives in the engine package (@ainyc/canonry) and this app
  // depends only on api-routes/config/contracts/db. Wiring it would mean taking
  // a dependency on the whole engine — providers, browser automation, the run
  // coordinator — inside a deployable that exists precisely to stay light.
  //
  // Nothing is lost: `canonry serve` is what runs on every self-hosted install
  // and every fleet tenant, and it registers the transport and the
  // authorization server. This app is the stateless REST surface, and an OAuth
  // server with no MCP resource behind it would authorize access to nothing.
  //
  // If that changes, both must move together: the metadata documents advertise
  // absolute URLs, so a host that publishes them without serving the resource
  // sends clients somewhere that 404s.
  registerTelemetryCollectorRoutes(app)
  registerHealthRoutes(app, env)

  return app
}
