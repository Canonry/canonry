export const queryKeys = {
  projects: {
    all: ['projects'] as const,
    detail: (id: string, latestRunId?: string) => ['projects', id, latestRunId] as const,
    keywords: (name: string) => ['projects', name, 'keywords'] as const,
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
    connections: ['gsc', 'connections'] as const,
    properties: ['gsc', 'properties'] as const,
    performance: (project: string) => ['gsc', project, 'performance'] as const,
    inspections: (project: string) => ['gsc', project, 'inspections'] as const,
    deindexed: (project: string) => ['gsc', project, 'deindexed'] as const,
    coverage: (project: string) => ['gsc', project, 'coverage'] as const,
    coverageHistory: (project: string) => ['gsc', project, 'coverage-history'] as const,
    sitemaps: (project: string) => ['gsc', project, 'sitemaps'] as const,
  },
  schedule: (project: string) => ['schedule', project] as const,
  notifications: (project: string) => ['notifications', project] as const,
}
