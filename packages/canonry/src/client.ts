import { loadConfig } from './config.js'
import type {
  SnapshotReportDto,
  WordpressAuditIssueDto,
  WordpressAuditPageDto,
  WordpressDiffDto,
  WordpressEnv,
  WordpressManualAssistDto,
  WordpressPageDetailDto,
  WordpressPageSummaryDto,
  WordpressSchemaBlockDto,
  WordpressStatusDto,
} from '@ainyc/canonry-contracts'

/**
 * Create an ApiClient using the loaded config.
 * This is the canonical way to get a client — it ensures basePath and env var
 * overrides (CANONRY_PORT, CANONRY_BASE_PATH) are always incorporated.
 *
 * When no basePath is configured locally (config.yaml or CANONRY_BASE_PATH env),
 * the client will auto-discover it from the server's /health endpoint on the
 * first API call.
 */
export function createApiClient(): ApiClient {
  const config = loadConfig()
  // basePath is already resolved if configured in config.yaml or env var.
  // Also treat an explicitly-set CANONRY_BASE_PATH (even empty) as resolved,
  // since the user is deliberately controlling the value.
  const basePathResolved = !!config.basePath || 'CANONRY_BASE_PATH' in process.env
  return new ApiClient(config.apiUrl, config.apiKey, { skipProbe: basePathResolved })
}

export class ApiClient {
  private baseUrl: string
  private originUrl: string
  private apiKey: string
  private probePromise: Promise<void> | null = null
  private probeSkipped: boolean

  constructor(baseUrl: string, apiKey: string, opts?: { skipProbe?: boolean }) {
    this.originUrl = baseUrl.replace(/\/$/, '')
    this.baseUrl = this.originUrl + '/api/v1'
    this.apiKey = apiKey
    this.probeSkipped = opts?.skipProbe ?? false
  }

  /**
   * On first API call, probe /health to auto-discover basePath when the user
   * hasn't configured one locally. This lets `canonry run` in a separate shell
   * discover that the server is running at e.g. /canonry/ without requiring
   * config.yaml edits or CANONRY_BASE_PATH in every shell.
   */
  private probeBasePath(): Promise<void> {
    if (this.probeSkipped) return Promise.resolve()
    if (!this.probePromise) {
      this.probePromise = (async () => {
        try {
          const origin = new URL(this.originUrl).origin
          const res = await fetch(`${origin}/health`, {
            signal: AbortSignal.timeout(2000),
          })
          if (res.ok) {
            const body = (await res.json()) as { basePath?: string }
            if (body.basePath && typeof body.basePath === 'string') {
              const normalized = '/' + body.basePath.replace(/^\/|\/$/g, '')
              if (normalized !== '/') {
                this.originUrl = origin + normalized
                this.baseUrl = this.originUrl + '/api/v1'
              }
            }
          }
        } catch {
          // Health probe failed (server not reachable, timeout, etc.) —
          // proceed with the locally-configured URL. The actual API call
          // will surface its own connection error.
        }
      })()
    }
    return this.probePromise
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.probeBasePath()
    const url = `${this.baseUrl}${path}`
    const serializedBody = body != null ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      ...(serializedBody != null ? { 'Content-Type': 'application/json' } : {}),
    }

    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: serializedBody,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('connect ECONNREFUSED')) {
        throw new Error(
          `Could not connect to canonry server at ${this.baseUrl.replace('/api/v1', '')}. ` +
          'Start it with "canonry serve" (or "canonry serve &" to run in background).',
        )
      }
      throw err
    }

    if (!res.ok) {
      let errorBody: unknown
      try {
        errorBody = await res.json()
      } catch {
        errorBody = { error: { code: 'UNKNOWN', message: res.statusText } }
      }
      const msg =
        errorBody &&
        typeof errorBody === 'object' &&
        'error' in errorBody &&
        errorBody.error &&
        typeof errorBody.error === 'object' &&
        'message' in errorBody.error
          ? String((errorBody.error as { message: string }).message)
          : `HTTP ${res.status}: ${res.statusText}`
      throw new Error(msg)
    }

    if (res.status === 204) {
      return undefined as T
    }

    return (await res.json()) as T
  }

  async putProject(name: string, body: object): Promise<object> {
    return this.request<object>('PUT', `/projects/${encodeURIComponent(name)}`, body)
  }

  async listProjects(): Promise<object[]> {
    return this.request<object[]>('GET', '/projects')
  }

  async getProject(name: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(name)}`)
  }

  async deleteProject(name: string): Promise<void> {
    await this.request<void>('DELETE', `/projects/${encodeURIComponent(name)}`)
  }

  async putKeywords(project: string, keywords: string[]): Promise<void> {
    await this.request<unknown>('PUT', `/projects/${encodeURIComponent(project)}/keywords`, { keywords })
  }

  async listKeywords(project: string): Promise<object[]> {
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/keywords`)
  }

  async deleteKeywords(project: string, keywords: string[]): Promise<void> {
    await this.request<unknown>('DELETE', `/projects/${encodeURIComponent(project)}/keywords`, { keywords })
  }

  async appendKeywords(project: string, keywords: string[]): Promise<void> {
    await this.request<unknown>('POST', `/projects/${encodeURIComponent(project)}/keywords`, { keywords })
  }

  async putCompetitors(project: string, competitors: string[]): Promise<void> {
    await this.request<unknown>('PUT', `/projects/${encodeURIComponent(project)}/competitors`, { competitors })
  }

  async listCompetitors(project: string): Promise<object[]> {
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/competitors`)
  }

  async triggerRun(project: string, body?: Record<string, unknown>): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/runs`, body ?? {})
  }

  async listRuns(project: string, limit?: number): Promise<object[]> {
    const query = limit != null ? `?limit=${encodeURIComponent(String(limit))}` : ''
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/runs${query}`)
  }

  async getRun(id: string): Promise<object> {
    return this.request<object>('GET', `/runs/${encodeURIComponent(id)}`)
  }

  async cancelRun(id: string): Promise<object> {
    return this.request<object>('POST', `/runs/${encodeURIComponent(id)}/cancel`)
  }

  async getTimeline(project: string): Promise<object[]> {
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/timeline`)
  }

  async getHistory(project: string): Promise<object[]> {
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/history`)
  }

  async getExport(project: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/export`)
  }

  async apply(config: object): Promise<object> {
    return this.request<object>('POST', '/apply', config)
  }

  async getStatus(project: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}`)
  }

  async getSettings(): Promise<object> {
    return this.request<object>('GET', '/settings')
  }

  async createSnapshot(body: {
    companyName: string
    domain: string
    phrases?: string[]
    competitors?: string[]
  }): Promise<SnapshotReportDto> {
    return this.request<SnapshotReportDto>('POST', '/snapshot', body)
  }

  async updateProvider(name: string, body: { apiKey?: string; baseUrl?: string; model?: string; quota?: { maxConcurrency?: number; maxRequestsPerMinute?: number; maxRequestsPerDay?: number } }): Promise<object> {
    return this.request<object>('PUT', `/settings/providers/${encodeURIComponent(name)}`, body)
  }

  async putSchedule(project: string, body: object): Promise<object> {
    return this.request<object>('PUT', `/projects/${encodeURIComponent(project)}/schedule`, body)
  }

  async getSchedule(project: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/schedule`)
  }

  async deleteSchedule(project: string): Promise<void> {
    await this.request<void>('DELETE', `/projects/${encodeURIComponent(project)}/schedule`)
  }

  async createNotification(project: string, body: object): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/notifications`, body)
  }

  async listNotifications(project: string): Promise<object[]> {
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/notifications`)
  }

  async deleteNotification(project: string, id: string): Promise<void> {
    await this.request<void>('DELETE', `/projects/${encodeURIComponent(project)}/notifications/${encodeURIComponent(id)}`)
  }

  async testNotification(project: string, id: string): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/notifications/${encodeURIComponent(id)}/test`)
  }

  async addLocation(project: string, body: { label: string; city: string; region: string; country: string; timezone?: string }): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/locations`, body)
  }

  async listLocations(project: string): Promise<{ locations: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation: string | null }> {
    return this.request<{ locations: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation: string | null }>('GET', `/projects/${encodeURIComponent(project)}/locations`)
  }

  async removeLocation(project: string, label: string): Promise<void> {
    await this.request<void>('DELETE', `/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(label)}`)
  }

  async setDefaultLocation(project: string, label: string): Promise<object> {
    return this.request<object>('PUT', `/projects/${encodeURIComponent(project)}/locations/default`, { label })
  }

  async getTelemetry(): Promise<{ enabled: boolean; anonymousId?: string }> {
    return this.request<{ enabled: boolean; anonymousId?: string }>('GET', '/telemetry')
  }

  async updateTelemetry(enabled: boolean): Promise<{ enabled: boolean; anonymousId?: string }> {
    return this.request<{ enabled: boolean; anonymousId?: string }>('PUT', '/telemetry', { enabled })
  }

  async generateKeywords(project: string, provider: string, count?: number): Promise<{ keywords: string[]; provider: string }> {
    return this.request<{ keywords: string[]; provider: string }>(
      'POST',
      `/projects/${encodeURIComponent(project)}/keywords/generate`,
      { provider, count },
    )
  }

  // Google connection management
  async googleConnect(project: string, body: { type: string; propertyId?: string; publicUrl?: string }): Promise<{ authUrl: string; redirectUri?: string }> {
    return this.request<{ authUrl: string; redirectUri?: string }>('POST', `/projects/${encodeURIComponent(project)}/google/connect`, body)
  }

  async googleConnections(project: string): Promise<object[]> {
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/google/connections`)
  }

  async googleDisconnect(project: string, type: string): Promise<void> {
    await this.request<void>('DELETE', `/projects/${encodeURIComponent(project)}/google/connections/${encodeURIComponent(type)}`)
  }

  async googleProperties(project: string): Promise<{ sites: Array<{ siteUrl: string; permissionLevel: string }> }> {
    return this.request<{ sites: Array<{ siteUrl: string; permissionLevel: string }> }>('GET', `/projects/${encodeURIComponent(project)}/google/properties`)
  }

  async googleSetProperty(project: string, type: string, propertyId: string): Promise<object> {
    return this.request<object>('PUT', `/projects/${encodeURIComponent(project)}/google/connections/${encodeURIComponent(type)}/property`, { propertyId })
  }

  async googleSetSitemap(project: string, type: string, sitemapUrl: string): Promise<object> {
    return this.request<object>('PUT', `/projects/${encodeURIComponent(project)}/google/connections/${encodeURIComponent(type)}/sitemap`, { sitemapUrl })
  }

  // GSC data
  async gscSync(project: string, body?: { days?: number; full?: boolean }): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/google/gsc/sync`, body ?? {})
  }

  async gscPerformance(project: string, params?: Record<string, string>): Promise<object[]> {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/google/gsc/performance${qs}`)
  }

  async gscInspect(project: string, url: string): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/google/gsc/inspect`, { url })
  }

  async gscInspections(project: string, params?: Record<string, string>): Promise<object[]> {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/google/gsc/inspections${qs}`)
  }

  async gscDeindexed(project: string): Promise<object[]> {
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/google/gsc/deindexed`)
  }

  async gscCoverage(project: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/google/gsc/coverage`)
  }

  async gscCoverageHistory(project: string, params?: { limit?: number }): Promise<object[]> {
    const qs = params?.limit != null ? `?limit=${params.limit}` : ''
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/google/gsc/coverage/history${qs}`)
  }

  async gscInspectSitemap(project: string, body?: { sitemapUrl?: string }): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/google/gsc/inspect-sitemap`, body ?? {})
  }

  async gscSitemaps(project: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/google/gsc/sitemaps`)
  }

  async gscDiscoverSitemaps(project: string): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/google/gsc/discover-sitemaps`, {})
  }

  // Analytics
  async getAnalyticsMetrics(project: string, window?: string): Promise<object> {
    const qs = window ? `?window=${encodeURIComponent(window)}` : ''
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/analytics/metrics${qs}`)
  }

  async getAnalyticsGaps(project: string, window?: string): Promise<object> {
    const qs = window ? `?window=${encodeURIComponent(window)}` : ''
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/analytics/gaps${qs}`)
  }

  async getAnalyticsSources(project: string, window?: string): Promise<object> {
    const qs = window ? `?window=${encodeURIComponent(window)}` : ''
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/analytics/sources${qs}`)
  }

  // Google Indexing API
  async googleRequestIndexing(project: string, body: { urls: string[]; allUnindexed?: boolean }): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/google/indexing/request`, body)
  }

  // Bing Webmaster Tools
  async bingConnect(project: string, body: { apiKey: string }): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/bing/connect`, body)
  }

  async bingDisconnect(project: string): Promise<void> {
    await this.request<void>('DELETE', `/projects/${encodeURIComponent(project)}/bing/disconnect`)
  }

  async bingStatus(project: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/bing/status`)
  }

  async bingSites(project: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/bing/sites`)
  }

  async bingSetSite(project: string, siteUrl: string): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/bing/set-site`, { siteUrl })
  }

  async bingCoverage(project: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/bing/coverage`)
  }

  async bingInspections(project: string, params?: Record<string, string>): Promise<object[]> {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/bing/inspections${qs}`)
  }

  async bingInspectUrl(project: string, url: string): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/bing/inspect-url`, { url })
  }

  async bingRequestIndexing(project: string, body: { urls?: string[]; allUnindexed?: boolean }): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/bing/request-indexing`, body)
  }

  async bingPerformance(project: string, params?: Record<string, string>): Promise<object[]> {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/bing/performance${qs}`)
  }

  // CDP browser provider
  async getCdpStatus(): Promise<object> {
    return this.request<object>('GET', '/cdp/status')
  }

  async cdpScreenshot(query: string, targets?: string[]): Promise<object> {
    return this.request<object>('POST', '/cdp/screenshot', { query, targets })
  }

  async getBrowserDiff(project: string, runId: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/runs/${encodeURIComponent(runId)}/browser-diff`)
  }

  // Google Analytics 4
  async gaConnect(project: string, body: { propertyId: string; keyJson?: string }): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/ga/connect`, body)
  }

  async gaDisconnect(project: string): Promise<void> {
    await this.request<void>('DELETE', `/projects/${encodeURIComponent(project)}/ga/disconnect`)
  }

  async gaStatus(project: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/ga/status`)
  }

  async gaSync(project: string, body?: { days?: number }): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/ga/sync`, body ?? {})
  }

  async gaTraffic(project: string, params?: Record<string, string>): Promise<object> {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/ga/traffic${qs}`)
  }

  async gaCoverage(project: string): Promise<object> {
    return this.request<object>('GET', `/projects/${encodeURIComponent(project)}/ga/coverage`)
  }

  async wordpressConnect(
    project: string,
    body: {
      url: string
      stagingUrl?: string
      username: string
      appPassword: string
      defaultEnv?: WordpressEnv
    },
  ): Promise<WordpressStatusDto> {
    return this.request<WordpressStatusDto>('POST', `/projects/${encodeURIComponent(project)}/wordpress/connect`, body)
  }

  async wordpressDisconnect(project: string): Promise<void> {
    await this.request<void>('DELETE', `/projects/${encodeURIComponent(project)}/wordpress/disconnect`)
  }

  async wordpressStatus(project: string): Promise<WordpressStatusDto> {
    return this.request<WordpressStatusDto>('GET', `/projects/${encodeURIComponent(project)}/wordpress/status`)
  }

  async wordpressPages(project: string, env?: WordpressEnv): Promise<{ env: WordpressEnv; pages: WordpressPageSummaryDto[] }> {
    const qs = env ? `?env=${encodeURIComponent(env)}` : ''
    return this.request<{ env: WordpressEnv; pages: WordpressPageSummaryDto[] }>('GET', `/projects/${encodeURIComponent(project)}/wordpress/pages${qs}`)
  }

  async wordpressPage(project: string, slug: string, env?: WordpressEnv): Promise<WordpressPageDetailDto> {
    const params = new URLSearchParams({ slug })
    if (env) params.set('env', env)
    return this.request<WordpressPageDetailDto>('GET', `/projects/${encodeURIComponent(project)}/wordpress/page?${params.toString()}`)
  }

  async wordpressCreatePage(
    project: string,
    body: { title: string; slug: string; content: string; status?: string; env?: WordpressEnv },
  ): Promise<WordpressPageDetailDto> {
    return this.request<WordpressPageDetailDto>('POST', `/projects/${encodeURIComponent(project)}/wordpress/pages`, body)
  }

  async wordpressUpdatePage(
    project: string,
    body: { currentSlug: string; title?: string; slug?: string; content?: string; status?: string; env?: WordpressEnv },
  ): Promise<WordpressPageDetailDto> {
    return this.request<WordpressPageDetailDto>('PUT', `/projects/${encodeURIComponent(project)}/wordpress/page`, body)
  }

  async wordpressSetMeta(
    project: string,
    body: { slug: string; title?: string; description?: string; noindex?: boolean; env?: WordpressEnv },
  ): Promise<WordpressPageDetailDto> {
    return this.request<WordpressPageDetailDto>('POST', `/projects/${encodeURIComponent(project)}/wordpress/page/meta`, body)
  }

  async wordpressSchema(
    project: string,
    slug: string,
    env?: WordpressEnv,
  ): Promise<{ env: WordpressEnv; slug: string; blocks: WordpressSchemaBlockDto[] }> {
    const params = new URLSearchParams({ slug })
    if (env) params.set('env', env)
    return this.request<{ env: WordpressEnv; slug: string; blocks: WordpressSchemaBlockDto[] }>('GET', `/projects/${encodeURIComponent(project)}/wordpress/schema?${params.toString()}`)
  }

  async wordpressSetSchema(
    project: string,
    body: { slug: string; type?: string; json: string; env?: WordpressEnv },
  ): Promise<WordpressManualAssistDto> {
    return this.request<WordpressManualAssistDto>('POST', `/projects/${encodeURIComponent(project)}/wordpress/schema/manual`, body)
  }

  async wordpressLlmsTxt(
    project: string,
    env?: WordpressEnv,
  ): Promise<{ env: WordpressEnv; url: string; content: string | null }> {
    const qs = env ? `?env=${encodeURIComponent(env)}` : ''
    return this.request<{ env: WordpressEnv; url: string; content: string | null }>('GET', `/projects/${encodeURIComponent(project)}/wordpress/llms-txt${qs}`)
  }

  async wordpressSetLlmsTxt(
    project: string,
    body: { content: string; env?: WordpressEnv },
  ): Promise<WordpressManualAssistDto> {
    return this.request<WordpressManualAssistDto>('POST', `/projects/${encodeURIComponent(project)}/wordpress/llms-txt/manual`, body)
  }

  async wordpressAudit(
    project: string,
    env?: WordpressEnv,
  ): Promise<{ env: WordpressEnv; pages: WordpressAuditPageDto[]; issues: WordpressAuditIssueDto[] }> {
    const qs = env ? `?env=${encodeURIComponent(env)}` : ''
    return this.request<{ env: WordpressEnv; pages: WordpressAuditPageDto[]; issues: WordpressAuditIssueDto[] }>('GET', `/projects/${encodeURIComponent(project)}/wordpress/audit${qs}`)
  }

  async wordpressDiff(project: string, slug: string): Promise<WordpressDiffDto> {
    const params = new URLSearchParams({ slug })
    return this.request<WordpressDiffDto>('GET', `/projects/${encodeURIComponent(project)}/wordpress/diff?${params.toString()}`)
  }

  async wordpressStagingStatus(project: string): Promise<{
    stagingConfigured: boolean
    stagingUrl: string | null
    wpStagingActive: boolean
    adminUrl: string
  }> {
    return this.request<{
      stagingConfigured: boolean
      stagingUrl: string | null
      wpStagingActive: boolean
      adminUrl: string
    }>('GET', `/projects/${encodeURIComponent(project)}/wordpress/staging/status`)
  }

  async wordpressStagingPush(project: string): Promise<WordpressManualAssistDto> {
    return this.request<WordpressManualAssistDto>('POST', `/projects/${encodeURIComponent(project)}/wordpress/staging/push`)
  }

}
