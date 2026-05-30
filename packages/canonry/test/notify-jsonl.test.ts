import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockListNotifications = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listNotifications: mockListNotifications,
  }),
}))

/** Capture `process.stdout.write` (the jsonl path) rather than console.log. */
function captureStdout(fn: () => Promise<void> | void): { run: Promise<void>; lines: () => string[] } {
  let buf = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk)
    return true
  })
  const run = Promise.resolve(fn()).finally(() => spy.mockRestore())
  return { run, lines: () => buf.split('\n').filter(Boolean) }
}

const { listNotifications, listEvents } = await import('../src/commands/notify.js')

const notificationRows = [
  {
    id: 'ntf_1',
    projectId: 'proj_demo',
    channel: 'webhook',
    url: 'https://example.com/hook-1',
    urlDisplay: 'https://example.com/hook-1',
    urlHost: 'example.com',
    events: ['run.completed', 'run.failed'],
    enabled: true,
  },
  {
    id: 'ntf_2',
    projectId: 'proj_demo',
    channel: 'webhook',
    url: 'https://example.com/hook-2',
    events: ['insight.critical'],
    enabled: false,
  },
]

describe('listNotifications jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('format=jsonl emits one self-contained notification per line', async () => {
    mockListNotifications.mockResolvedValue(notificationRows)
    const cap = captureStdout(() => listNotifications('demo', 'jsonl'))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map(l => JSON.parse(l!))
    // Records self-identify via projectId — emitted BARE, no `project` tag injected.
    expect(records[0]).toEqual(notificationRows[0])
    expect(records[1]).toEqual(notificationRows[1])
  })

  it('format=jsonl: each line carries its own projectId (self-contained)', async () => {
    mockListNotifications.mockResolvedValue(notificationRows)
    const cap = captureStdout(() => listNotifications('demo', 'jsonl'))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l!))
    expect(records.every(r => r.projectId === 'proj_demo')).toBe(true)
    expect(records.every(r => typeof r.id === 'string')).toBe(true)
  })

  it('format=jsonl: empty collection writes nothing', async () => {
    mockListNotifications.mockResolvedValue([])
    const cap = captureStdout(() => listNotifications('demo', 'jsonl'))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('format=json is unchanged — emits the full envelope exactly as before', async () => {
    mockListNotifications.mockResolvedValue(notificationRows)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await listNotifications('demo', 'json')
    } finally {
      console.log = origLog
    }
    expect(JSON.parse(logs.join(''))).toEqual(notificationRows)
  })
})

describe('listEvents jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('format=jsonl emits one self-contained event record per line', async () => {
    const cap = captureStdout(() => listEvents('jsonl'))
    await cap.run
    const lines = cap.lines()
    // Static global catalog — one line per notification event.
    expect(lines.length).toBeGreaterThan(0)
    const records = lines.map(l => JSON.parse(l!))
    // Global static catalog → emitted BARE, no tag; each record self-identifies via `event`.
    for (const record of records) {
      expect(typeof record.event).toBe('string')
      expect(typeof record.description).toBe('string')
      expect(Object.keys(record).sort()).toEqual(['description', 'event'])
    }
  })

  it('format=jsonl: line count matches the json-branch catalog length', async () => {
    // Source the canonical catalog from the json branch and assert jsonl mirrors it.
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    let jsonCatalog: Array<{ event: string; description: string }>
    try {
      listEvents('json')
      jsonCatalog = JSON.parse(logs.join('')) as Array<{ event: string; description: string }>
    } finally {
      console.log = origLog
    }
    const cap = captureStdout(() => listEvents('jsonl'))
    await cap.run
    const records = cap.lines().map(l => JSON.parse(l!))
    expect(records).toEqual(jsonCatalog)
  })

  it('format=json is unchanged — emits the full catalog exactly as before', () => {
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      listEvents('json')
    } finally {
      console.log = origLog
    }
    const catalog = JSON.parse(logs.join('')) as Array<{ event: string; description: string }>
    // Every event has a string event + description; no extra keys.
    expect(catalog.length).toBeGreaterThan(0)
    for (const entry of catalog) {
      expect(Object.keys(entry).sort()).toEqual(['description', 'event'])
    }
  })
})
