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

    const res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    })

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

  async triggerRun(project: string): Promise<object> {
    return this.request<object>('POST', `/projects/${encodeURIComponent(project)}/runs`, {})
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
}
