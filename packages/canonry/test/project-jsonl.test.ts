import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { ProjectDto } from '@ainyc/canonry-contracts'

const mockListProjects = vi.fn()
const mockListLocations = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listProjects: mockListProjects,
    listLocations: mockListLocations,
  }),
}))

/** Capture `process.stdout.write` (the jsonl path) rather than console.log. */
function captureStdout(fn: () => Promise<void>): { run: Promise<void>; lines: () => string[] } {
  let buf = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk)
    return true
  })
  const run = fn().finally(() => spy.mockRestore())
  return { run, lines: () => buf.split('\n').filter(Boolean) }
}

/** Capture `console.log` (the json + human paths). */
function captureLog(fn: () => Promise<void>): { run: Promise<void>; text: () => string } {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  const run = fn().finally(() => { console.log = origLog })
  return { run, text: () => logs.join('\n') }
}

const { listProjects, listLocations } = await import('../src/commands/project.js')

const projectA: ProjectDto = {
  id: 'proj_a',
  name: 'alpha',
  displayName: 'Alpha',
  canonicalDomain: 'alpha.com',
  ownedDomains: [],
  aliases: [],
  country: 'US',
  language: 'en',
  configSource: 'api',
  configRevision: 1,
  tags: [],
  labels: {},
  locations: [],
  defaultLocation: null,
}

const projectB: ProjectDto = {
  ...projectA,
  id: 'proj_b',
  name: 'bravo',
  displayName: 'Bravo',
  canonicalDomain: 'bravo.com',
}

describe('listProjects --format jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits one self-contained project per line, BARE (global, no tag)', async () => {
    mockListProjects.mockResolvedValue([projectA, projectB])
    const cap = captureStdout(() => listProjects('jsonl'))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map(l => JSON.parse(l))
    // Each record self-identifies via name/id — no injected project tag.
    expect(records[0]).toMatchObject({ id: 'proj_a', name: 'alpha', canonicalDomain: 'alpha.com' })
    expect(records[1]).toMatchObject({ id: 'proj_b', name: 'bravo', canonicalDomain: 'bravo.com' })
    // Global records are emitted bare — no `project` envelope tag.
    expect(records[0]).not.toHaveProperty('project')
    expect(records[1]).not.toHaveProperty('project')
  })

  it('emits nothing for an empty project list', async () => {
    mockListProjects.mockResolvedValue([])
    const cap = captureStdout(() => listProjects('jsonl'))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('leaves the --format json branch unchanged (full envelope, pretty-printed)', async () => {
    const projects = [projectA, projectB]
    mockListProjects.mockResolvedValue(projects)
    const cap = captureLog(() => listProjects('json'))
    await cap.run
    expect(JSON.parse(cap.text())).toEqual(projects)
  })
})

describe('listLocations --format jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const locations = [
    { label: 'hq', city: 'Detroit', region: 'MI', country: 'US', timezone: 'America/Detroit' },
    { label: 'west', city: 'Los Angeles', region: 'CA', country: 'US', timezone: 'America/Los_Angeles' },
  ]
  const result = { locations, defaultLocation: 'hq' }

  it('emits one self-contained location per line, tagged with project + isDefault', async () => {
    mockListLocations.mockResolvedValue(result)
    const cap = captureStdout(() => listLocations('demo', 'jsonl'))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map(l => JSON.parse(l))
    // Every line carries the project tag it loses by leaving the envelope.
    expect(records.every(r => r.project === 'demo')).toBe(true)
    // isDefault is derived per line by comparing label to the envelope's default.
    expect(records[0]).toMatchObject({ project: 'demo', label: 'hq', city: 'Detroit', isDefault: true })
    expect(records[1]).toMatchObject({ project: 'demo', label: 'west', city: 'Los Angeles', isDefault: false })
  })

  it('record fields win over injected context (record spread last)', async () => {
    mockListLocations.mockResolvedValue(result)
    const cap = captureStdout(() => listLocations('demo', 'jsonl'))
    await cap.run
    const record = JSON.parse(cap.lines()[0]!)
    // Location's own fields (label/city/region/country/timezone) are intact.
    expect(record).toMatchObject({
      label: 'hq',
      city: 'Detroit',
      region: 'MI',
      country: 'US',
      timezone: 'America/Detroit',
    })
  })

  it('marks no location default when defaultLocation is null', async () => {
    mockListLocations.mockResolvedValue({ locations, defaultLocation: null })
    const cap = captureStdout(() => listLocations('demo', 'jsonl'))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l))
    expect(records.every(r => r.isDefault === false)).toBe(true)
  })

  it('emits nothing for an empty location list', async () => {
    mockListLocations.mockResolvedValue({ locations: [], defaultLocation: null })
    const cap = captureStdout(() => listLocations('demo', 'jsonl'))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('leaves the --format json branch unchanged (full envelope, pretty-printed)', async () => {
    mockListLocations.mockResolvedValue(result)
    const cap = captureLog(() => listLocations('demo', 'json'))
    await cap.run
    expect(JSON.parse(cap.text())).toEqual(result)
  })
})
