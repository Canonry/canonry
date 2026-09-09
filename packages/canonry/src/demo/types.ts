export interface DemoSeedProject {
  id: string
  name: string
  displayName: string
  domain: string
}

export interface DemoSeedContext {
  now: Date
  simple: DemoSeedProject
  portfolio: DemoSeedProject
}

export function createDemoSeedContext(now = new Date()): DemoSeedContext {
  return {
    now,
    simple: { id: 'demo-project-summit', name: 'summit-roofing', displayName: 'Summit Roofing', domain: 'summit-roofing.example' },
    portfolio: { id: 'demo-project-harbor', name: 'harbor-resorts', displayName: 'Harbor Resorts', domain: 'harbor-resorts.example' },
  }
}
