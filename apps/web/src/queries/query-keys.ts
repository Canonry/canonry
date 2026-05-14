export const queryKeys = {
  projects: {
    all: ['projects'] as const,
    detail: (id: string, latestRunId?: string) => ['projects', id, latestRunId] as const,
    queries: (name: string) => ['projects', name, 'queries'] as const,
    competitors: (name: string) => ['projects', name, 'competitors'] as const,
    timeline: (name: string, location?: string) => ['projects', name, 'timeline', location] as const,
  },
  runs: {
    all: ['runs'] as const,
    detail: (id: string) => ['runs', id] as const,
  },
  settings: ['settings'] as const,
  health: ['health'] as const,
  gsc: {
    project: (project: string) => ['gsc', project] as const,
    connections: (project: string) => ['gsc', project, 'connections'] as const,
    properties: (project: string) => ['gsc', project, 'properties'] as const,
    performance: (project: string, filters?: Record<string, string>) => ['gsc', project, 'performance', filters] as const,
    inspections: (project: string, url?: string) => ['gsc', project, 'inspections', url] as const,
    deindexed: (project: string) => ['gsc', project, 'deindexed'] as const,
    coverage: (project: string) => ['gsc', project, 'coverage'] as const,
    coverageHistory: (project: string) => ['gsc', project, 'coverage-history'] as const,
    sitemaps: (project: string) => ['gsc', project, 'sitemaps'] as const,
  },
  bing: {
    project: (project: string) => ['bing', project] as const,
    status: (project: string) => ['bing', project, 'status'] as const,
    coverage: (project: string) => ['bing', project, 'coverage'] as const,
    inspections: (project: string) => ['bing', project, 'inspections'] as const,
    performance: (project: string) => ['bing', project, 'performance'] as const,
    sites: (project: string) => ['bing', project, 'sites'] as const,
  },
  schedule: (project: string) => ['schedule', project] as const,
  notifications: (project: string) => ['notifications', project] as const,
  agent: {
    providers: (project: string) => ['agent', project, 'providers'] as const,
  },
  discovery: {
    project: (project: string) => ['discovery', project] as const,
    sessions: (project: string) => ['discovery', project, 'sessions'] as const,
    session: (project: string, sessionId: string) => ['discovery', project, 'sessions', sessionId] as const,
    promotePreview: (project: string, sessionId: string) =>
      ['discovery', project, 'sessions', sessionId, 'promote-preview'] as const,
  },
  citationVisibility: (project: string) => ['citation-visibility', project] as const,
  report: (project: string) => ['report', project] as const,
  traffic: {
    project: (project: string) => ['traffic', project] as const,
    status: (project: string) => ['traffic', project, 'status'] as const,
    summary: (project: string, window: string) => ['traffic', project, 'summary', window] as const,
    aiHistory: (project: string, window: string) => ['traffic', project, 'ai-history', window] as const,
    sessionHistory: (project: string, window: string) => ['traffic', project, 'session-history', window] as const,
    socialHistory: (project: string, window: string) => ['traffic', project, 'social-history', window] as const,
  },
  serverTraffic: {
    all: ['server-traffic'] as const,
    project: (project: string) => ['server-traffic', project] as const,
    sources: (project: string) => ['server-traffic', project, 'sources'] as const,
    status: (project: string) => ['server-traffic', project, 'status'] as const,
    sourceDetail: (project: string, sourceId: string) =>
      ['server-traffic', project, 'sources', sourceId] as const,
    events: (
      project: string,
      filters: { kind?: string; sourceId?: string; sinceMinutes?: number; limit?: number },
    ) => ['server-traffic', project, 'events', filters] as const,
  },
}
