/**
 * Bot list manifest baked into the generated Worker script. Bumping
 * `version` means the deployed Worker is out of date — the
 * `cloudflare.worker.version-stale` doctor check reads this field on the
 * source row and compares it against the current package constant.
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
  refererHostSuffixes: readonly string[]
  refererHostKeywords: readonly string[]
}

export interface GenerateWorkerScriptOptions {
  sourceId: string
  ingestUrl: string
  bearerToken: string
  hmacSecret: string
  workerVersion: string
  botList: CloudflareWorkerBotList
  /** Optional `cf.botManagement.score` threshold below which to forward. */
  botScoreMaxForward?: number
}
