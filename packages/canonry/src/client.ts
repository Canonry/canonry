export class ApiClient {
  private baseUrl: string
  private apiKey: string

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '') + '/api/v1'
    this.apiKey = apiKey
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }

    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
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

  async listRuns(project: string): Promise<object[]> {
    return this.request<object[]>('GET', `/projects/${encodeURIComponent(project)}/runs`)
  }

  async getRun(id: string): Promise<object> {
    return this.request<object>('GET', `/runs/${encodeURIComponent(id)}`)
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
}
