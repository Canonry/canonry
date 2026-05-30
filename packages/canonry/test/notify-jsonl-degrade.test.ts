import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockCreateNotification = vi.fn()
const mockDeleteNotification = vi.fn()
const mockTestNotification = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    createNotification: mockCreateNotification,
    deleteNotification: mockDeleteNotification,
    testNotification: mockTestNotification,
  }),
}))

/** Capture console.log lines (the json / jsonl degrade path uses console.log). */
function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return fn()
    .finally(() => {
      console.log = origLog
    })
    .then(() => logs.join('\n'))
}

const { addNotification, removeNotification, testNotification } = await import('../src/commands/notify.js')

const created = {
  id: 'n1',
  projectId: 'p1',
  channel: 'webhook',
  url: 'https://example.com/hook',
  events: ['run.completed'],
  enabled: true,
}

describe('addNotification (mutation) — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateNotification.mockResolvedValue(created)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() =>
      addNotification('demo', { webhook: created.url, events: created.events, format: 'json' }),
    )
    const jsonlOut = await captureLog(() =>
      addNotification('demo', { webhook: created.url, events: created.events, format: 'jsonl' }),
    )

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(created)
  })

  it('format=jsonl does NOT print the human "Notification created" block', async () => {
    const out = await captureLog(() =>
      addNotification('demo', { webhook: created.url, events: created.events, format: 'jsonl' }),
    )
    expect(out).not.toMatch(/Notification created for/)
  })

  it('no format → human text output is unchanged', async () => {
    const out = await captureLog(() =>
      addNotification('demo', { webhook: created.url, events: created.events }),
    )
    expect(out).toMatch(/Notification created for "demo":/)
    expect(() => JSON.parse(out)).toThrow()
  })
})

describe('removeNotification (mutation) — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteNotification.mockResolvedValue(undefined)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => removeNotification('demo', 'n1', 'json'))
    const jsonlOut = await captureLog(() => removeNotification('demo', 'n1', 'jsonl'))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual({ project: 'demo', id: 'n1', removed: true })
  })

  it('no format → human text output is unchanged', async () => {
    const out = await captureLog(() => removeNotification('demo', 'n1', undefined))
    expect(out).toMatch(/Notification n1 removed from "demo"/)
    expect(() => JSON.parse(out)).toThrow()
  })
})

describe('testNotification (mutation) — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTestNotification.mockResolvedValue({ status: 200, ok: true })
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => testNotification('demo', 'n1', 'json'))
    const jsonlOut = await captureLog(() => testNotification('demo', 'n1', 'jsonl'))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual({ project: 'demo', id: 'n1', status: 200, ok: true })
  })

  it('no format → human text output is unchanged', async () => {
    const out = await captureLog(() => testNotification('demo', 'n1', undefined))
    expect(out).toMatch(/Test webhook delivered successfully \(HTTP 200\)/)
    expect(() => JSON.parse(out)).toThrow()
  })
})
