import { and, count, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import {
  adsConnections,
  auditLog,
  backlinkSummaries,
  bingConnections,
  competitors,
  discoverySessions,
  gaConnections,
  googleAdsConnections,
  googleConnections,
  gtmConnections,
  llmUsageEvents,
  notifications,
  projects,
  queries,
  querySnapshots,
  researchRuns,
  runs,
  schedules,
  trafficSources,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  INTEGRATION_NAMES,
  IntegrationNames,
  PROVIDER_NAMES,
  ProviderNames,
  RunKinds,
  RunTriggers,
  TrafficSourceStatuses,
  TrafficSourceTypes,
  bucketDuration,
  describeError,
  type IntegrationName,
  type InstallStateProperties,
} from '@ainyc/canonry-contracts'
import type { CanonryConfig } from './config.js'
import { isCdpProviderRegistrable, registeredProviderNames } from './provider-registration.js'
import { trackInstallState } from './outcome-telemetry.js'
import { isTelemetryEnabled } from './telemetry.js'
import { AeroLlmUsageFeatures } from './agent/llm-usage.js'
import { isAgentModelAvailable } from './agent/providers.js'
import { resolveSessionProviderAndModel } from './agent/session.js'
import { createLogger } from './logger.js'

const log = createLogger('InstallStateTelemetry')

/** The first report waits a few minutes so startup work and boot recovery go first. */
const INSTALL_STATE_FIRST_DELAY_MS = 5 * 60_000
const INSTALL_STATE_INTERVAL_MS = 24 * 60 * 60_000

export interface InstallStateSources {
  db: DatabaseClient
  /** The running server's config: providers, WordPress, CDP and the Aero settings. */
  config: CanonryConfig
  /** Whether Aero runs on this server; its provider and model are reported only then. */
  agentEnabled: boolean
  /** Whether the Common Crawl backlinks engine is installed. */
  isBacklinksInstalled: () => boolean
}

type ProviderName = (typeof PROVIDER_NAMES)[number]
type Usage24h = InstallStateProperties['usage24h']

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_NAMES)
const AGENT_WEBHOOK_SOURCE = 'agent'
const WEBHOOK_DELIVERED_ACTION = 'notification.sent'

const TRAFFIC_INTEGRATIONS: Partial<Record<string, IntegrationName>> = {
  [TrafficSourceTypes.cloudflare]: IntegrationNames.traffic_cloudflare,
  [TrafficSourceTypes.vercel]: IntegrationNames.traffic_vercel,
  [TrafficSourceTypes['cloud-run']]: IntegrationNames.traffic_cloud_run,
  // One WordPress integration covers the content connection and the traffic logger plugin.
  [TrafficSourceTypes.wordpress]: IntegrationNames.wordpress,
}

function whole(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0
}

/** What this install has set up, and what it did in the 24 hours before `now`. Small aggregated, indexed reads. */
function buildInstallState(sources: InstallStateSources, now: number, startedAt: number): InstallStateProperties {
  const { db, config } = sources
  const since = new Date(now - INSTALL_STATE_INTERVAL_MS).toISOString()
  const projectIds = db.select({ id: projects.id }).from(projects)
  const total = (query: { get: () => { value: number } | undefined }): number => whole(query.get()?.value)

  const googleByType = new Map(db.select({ type: googleConnections.connectionType, value: count() })
    .from(googleConnections).groupBy(googleConnections.connectionType).all()
    .map(row => [row.type, whole(row.value)]))
  const gaServiceAccounts = total(db.select({ value: count() }).from(gaConnections))
  const trafficByType = db.select({ type: trafficSources.sourceType, value: count() })
    .from(trafficSources)
    .where(and(isNull(trafficSources.archivedAt), ne(trafficSources.status, TrafficSourceStatuses.archived)))
    .groupBy(trafficSources.sourceType).all()
  const webhookSources = db.select({ config: notifications.config }).from(notifications)
    .where(eq(notifications.enabled, true)).all()
    .map(row => (row.config as { source?: unknown }).source)
  const agentWebhooks = webhookSources.filter(source => source === AGENT_WEBHOOK_SOURCE).length
  const webhooks = webhookSources.length - agentWebhooks
  const bing = total(db.select({ value: count() }).from(bingConnections))
  const openAiAds = total(db.select({ value: count() }).from(adsConnections))
  const googleAdsConnected = total(db.select({ value: count() }).from(googleAdsConnections))
  const backlinkSources = total(db.select({ value: count() }).from(
    db.selectDistinct({ projectId: backlinkSummaries.projectId, source: backlinkSummaries.source }).from(backlinkSummaries).as('backlink_sources'),
  ))

  const counts: InstallStateProperties['counts'] = {
    projects: total(db.select({ value: count() }).from(projects)),
    queries: total(db.select({ value: count() }).from(queries)),
    competitors: total(db.select({ value: count() }).from(competitors)),
    locations: total(db.select({ value: sql<number>`coalesce(sum(json_array_length(${projects.locations})), 0)` }).from(projects)),
    schedules: total(db.select({ value: count() }).from(schedules).where(eq(schedules.enabled, true))),
    webhooks,
    agentWebhooks,
    trafficSources: trafficByType.reduce((sum, row) => sum + whole(row.value), 0),
    googleConnections: [...googleByType.values()].reduce((sum, value) => sum + value, 0) + gaServiceAccounts,
    bingConnections: bing,
    backlinkSources,
    adsAccounts: openAiAds
      + total(db.select({ value: count() }).from(googleAdsConnections).where(isNotNull(googleAdsConnections.selectedCustomerId))),
  }

  const connected = new Set<IntegrationName>()
  if ((googleByType.get('gsc') ?? 0) > 0) connected.add(IntegrationNames.gsc)
  if ((googleByType.get('ga4') ?? 0) > 0 || gaServiceAccounts > 0) connected.add(IntegrationNames.ga4)
  if ((googleByType.get('gbp') ?? 0) > 0) connected.add(IntegrationNames.gbp)
  if (bing > 0) connected.add(IntegrationNames.bing)
  if (googleAdsConnected > 0) connected.add(IntegrationNames.google_ads)
  if (total(db.select({ value: count() }).from(gtmConnections)) > 0) connected.add(IntegrationNames.gtm)
  if (openAiAds > 0) connected.add(IntegrationNames.openai_ads)
  for (const row of trafficByType) {
    const integration = TRAFFIC_INTEGRATIONS[row.type]
    if (integration && whole(row.value) > 0) connected.add(integration)
  }
  if ((config.wordpress?.connections?.length ?? 0) > 0) connected.add(IntegrationNames.wordpress)
  if (backlinkSources > 0 || sources.isBacklinksInstalled()) connected.add(IntegrationNames.backlinks)
  if (webhooks > 0) connected.add(IntegrationNames.webhook)
  if (agentWebhooks > 0) connected.add(IntegrationNames.agent_webhook)
  if (isCdpProviderRegistrable(config.cdp)) connected.add(IntegrationNames.cdp)

  const providerCalls = new Map<ProviderName, number>()
  const addCalls = (provider: string | null, calls: number) => {
    if (!provider || !KNOWN_PROVIDERS.has(provider) || calls <= 0) return
    providerCalls.set(provider as ProviderName, (providerCalls.get(provider as ProviderName) ?? 0) + calls)
  }

  // Sweep and fill answers, with the usage and price each one stored.
  const usagePath = (field: string) => sql`json_extract(${querySnapshots.usage}, ${`$.${field}`})`
  const answers = db.select({
    provider: querySnapshots.provider,
    answers: count(),
    measured: sql<number>`sum(case when ${usagePath('inputTokens')} is not null then 1 else 0 end)`,
    unpriced: sql<number>`sum(case when ${usagePath('inputTokens')} is not null and ${usagePath('estimatedCostMicros')} is null then 1 else 0 end)`,
    inputTokens: sql<number>`coalesce(sum(${usagePath('inputTokens')}), 0)`,
    outputTokens: sql<number>`coalesce(sum(${usagePath('outputTokens')}), 0)`,
    costMicros: sql<number>`coalesce(sum(${usagePath('estimatedCostMicros')}), 0)`,
  }).from(querySnapshots).where(gte(querySnapshots.createdAt, since))
    // Unary plus: grouping on the bare column makes SQLite walk the provider index over the whole table.
    .groupBy(sql`+${querySnapshots.provider}`).all()
  for (const row of answers) addCalls(row.provider, whole(row.answers))

  // Research stores no token usage; its answered queries are provider calls.
  for (const row of db.select({ provider: researchRuns.provider, answered: sql<number>`coalesce(sum(${researchRuns.completedQueries}), 0)` })
    .from(researchRuns)
    .where(and(inArray(researchRuns.projectId, projectIds), gte(researchRuns.createdAt, since)))
    .groupBy(researchRuns.provider).all()) {
    addCalls(row.provider, whole(row.answered))
  }

  // Discovery: one seed call per seed provider once seeding ran, then Gemini probes.
  for (const session of db.select({
    seedProviders: discoverySessions.seedProviders,
    seedCountRaw: discoverySessions.seedCountRaw,
    probeCount: discoverySessions.probeCount,
  }).from(discoverySessions)
    .where(and(inArray(discoverySessions.projectId, projectIds), gte(discoverySessions.createdAt, since))).all()) {
    if (session.seedCountRaw !== null) {
      for (const provider of session.seedProviders?.length ? session.seedProviders : [ProviderNames.gemini]) addCalls(provider, 1)
    }
    addCalls(ProviderNames.gemini, whole(session.probeCount))
  }

  const answered = answers.reduce((sum, row) => sum + whole(row.answers), 0)
  const measured = answers.reduce((sum, row) => sum + whole(row.measured), 0)
  const usage24h: Usage24h = {
    sweeps: total(db.select({ value: count() }).from(runs).where(and(
      inArray(runs.projectId, projectIds),
      eq(runs.kind, RunKinds['answer-visibility']),
      gte(runs.createdAt, since),
      ne(runs.trigger, RunTriggers.probe),
    ))),
    audits: total(db.select({ value: count() }).from(runs).where(and(
      inArray(runs.projectId, projectIds),
      eq(runs.kind, RunKinds['site-audit']),
      gte(runs.createdAt, since),
    ))),
    providerCalls: [...providerCalls.values()].reduce((sum, calls) => sum + calls, 0),
  }
  // No answers means none to price: a known zero. Answers with no recorded usage are unmeasured, not free.
  if (answered === 0 || measured > 0) {
    usage24h.inputTokens = answers.reduce((sum, row) => sum + whole(row.inputTokens), 0)
    usage24h.outputTokens = answers.reduce((sum, row) => sum + whole(row.outputTokens), 0)
    if (answers.every(row => whole(row.unpriced) === 0)) {
      usage24h.costMicros = answers.reduce((sum, row) => sum + whole(row.costMicros), 0)
    }
  }

  const aero = db.select({
    calls: count(),
    inputTokens: sql<number>`coalesce(sum(${llmUsageEvents.inputTokens}), 0)`,
    outputTokens: sql<number>`coalesce(sum(${llmUsageEvents.outputTokens}), 0)`,
    costMillicents: sql<number>`coalesce(sum(${llmUsageEvents.costMillicents}), 0)`,
  }).from(llmUsageEvents)
    .where(and(eq(llmUsageEvents.feature, AeroLlmUsageFeatures.turn), gte(llmUsageEvents.createdAt, since)))
    .get()
  const aeroCalls = whole(aero?.calls)
  usage24h.aeroModelCalls = aeroCalls
  usage24h.aeroInputTokens = whole(aero?.inputTokens)
  usage24h.aeroOutputTokens = whole(aero?.outputTokens)
  // The ledger stores 0 for a model with no catalog price, which is unknown rather than free.
  const aeroMillicents = whole(aero?.costMillicents)
  if (aeroCalls === 0 || aeroMillicents > 0) usage24h.aeroCostMicros = aeroMillicents * 10
  usage24h.webhookDeliveries = total(db.select({ value: count() }).from(auditLog)
    .where(and(gte(auditLog.createdAt, since), eq(auditLog.action, WEBHOOK_DELIVERED_ACTION))))

  const providerCalls24h = Object.fromEntries(PROVIDER_NAMES.flatMap(name => providerCalls.has(name) ? [[name, providerCalls.get(name)!]] : []))
  return {
    providers: registeredProviderNames(config).filter((name): name is ProviderName => KNOWN_PROVIDERS.has(name)),
    integrations: INTEGRATION_NAMES.filter((name): name is Exclude<IntegrationName, 'provider'> => connected.has(name)),
    counts,
    usage24h,
    ...(Object.keys(providerCalls24h).length > 0 ? { providerCalls24h } : {}),
    ...(sources.agentEnabled ? aeroSettings(config) : {}),
    uptimeBucket: bucketDuration(now - startedAt),
  }
}

/** The provider and model Aero answers with by default, as a session would resolve them. */
function aeroSettings(config: CanonryConfig): Pick<InstallStateProperties, 'agentProvider' | 'agentModel'> {
  try {
    const { provider, modelId } = resolveSessionProviderAndModel(config)
    // Only a catalog model id is public; anything else in config.yaml stays local.
    return isAgentModelAvailable(provider, modelId) ? { agentProvider: provider, agentModel: modelId } : { agentProvider: provider }
  } catch {
    return {}
  }
}

/**
 * Send `install.state` a few minutes after the server starts listening, then
 * every 24 hours. The timer is unref'd so it never holds the process open, and
 * nothing is read while telemetry is off. Returns the stop function.
 */
export function startInstallStateTelemetry(sources: InstallStateSources): () => void {
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = (delayMs: number): void => {
    timer = setTimeout(report, delayMs)
    timer.unref()
  }
  const report = (): void => {
    if (stopped) return
    try {
      if (isTelemetryEnabled()) trackInstallState(buildInstallState(sources, Date.now(), startedAt))
    } catch (err: unknown) {
      log.warn('telemetry.install-state-failed', { error: describeError(err) })
    }
    schedule(INSTALL_STATE_INTERVAL_MS)
  }
  schedule(INSTALL_STATE_FIRST_DELAY_MS)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
