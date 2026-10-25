/**
 * Bot list manifest baked into the generated Worker script. Bumping
 * `version` means the deployed Worker is out of date. Also increment the
 * generated Worker version so `traffic.source.worker-version` detects drift.
 *
 * Edge-side classification is intentionally broad — the server-side
 * classifier in `packages/integration-traffic` does the real
 * bot-id/operator decisions. Keep this list large enough to catch any
 * AI-related signal even when canonry doesn't yet have a specific rule
 * for it.
 */
export interface CloudflareWorkerBotList {
  version: string
  uaKeywords: readonly string[]
  /** Exact canonical AI engine domains; subdomains match too. */
  refererDomains: readonly string[]
  /** Exact UTM source tokens accepted by the server-side classifier. */
  utmSourceTokens: readonly string[]
}

/** Stable binding names shared by generated source, Wrangler output, and CLI setup. */
export const CLOUDFLARE_WORKER_BINDINGS = {
  deliveryMode: 'CANONRY_DELIVERY_MODE',
  sourceId: 'CANONRY_SOURCE_ID',
  ingestUrl: 'CANONRY_INGEST_URL',
  workerVersion: 'CANONRY_WORKER_VERSION',
  bearerToken: 'CANONRY_BEARER_TOKEN',
  hmacSecret: 'CANONRY_HMAC_SECRET',
  trafficQueue: 'CANONRY_TRAFFIC_QUEUE',
} as const

export const CLOUDFLARE_DIRECT_PUSH_SECRET_BINDINGS = [
  CLOUDFLARE_WORKER_BINDINGS.bearerToken,
  CLOUDFLARE_WORKER_BINDINGS.hmacSecret,
] as const

/** Markers let the CLI update Canonry-owned artifacts without replacing operator files. */
export const CLOUDFLARE_WORKER_GENERATED_MARKER =
  '// canonry traffic Worker — generated; do not edit by hand'
export const CLOUDFLARE_WRANGLER_GENERATED_MARKER =
  '# canonry traffic Worker configuration — generated; do not edit by hand'

interface GenerateWorkerScriptBaseOptions {
  workerVersion: string
  botList: CloudflareWorkerBotList
  /** Optional `cf.botManagement.score` threshold below which to forward. */
  botScoreMaxForward?: number
  /**
   * Also forward people's full-page loads and form posts (document requests),
   * so AI visitor journeys see later visits. Off by default: the generated
   * Worker is then unchanged and forwards only AI and bot traffic.
   */
  forwardPageViews?: boolean
}

export type GenerateWorkerScriptOptions = GenerateWorkerScriptBaseOptions & (
  | { deliveryMode: 'direct-push' }
  | { deliveryMode: 'queue-pull' }
)

interface GenerateWranglerTomlBaseOptions {
  deliveryMode: 'direct-push'
  sourceId: string
  hostname: string
  workerVersion: string
  accountId?: string | null
  zoneId?: string | null
}

export type GenerateWranglerTomlOptions =
  | (Omit<GenerateWranglerTomlBaseOptions, 'deliveryMode'> & {
    deliveryMode: 'direct-push'
    ingestUrl: string
  })
  | (Omit<GenerateWranglerTomlBaseOptions, 'deliveryMode'> & {
    deliveryMode: 'queue-pull'
    queueName: string
  })
