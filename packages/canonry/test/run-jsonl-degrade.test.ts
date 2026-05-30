import { describe, expect, it, beforeEach, vi } from 'vitest'

// Mocked ApiClient methods used by the run.ts and agent.ts handlers.
const mockTriggerRun = vi.fn()
const mockGetRun = vi.fn()
const mockCancelRun = vi.fn()
const mockListRuns = vi.fn()
const mockListNotifications = vi.fn()
const mockCreateNotification = vi.fn()
const mockDeleteNotification = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    triggerRun: mockTriggerRun,
    getRun: mockGetRun,
    cancelRun: mockCancelRun,
    listRuns: mockListRuns,
    listNotifications: mockListNotifications,
    createNotification: mockCreateNotification,
    deleteNotification: mockDeleteNotification,
  }),
}))

/** Capture `console.log` (the json document path). */
function captureLog(fn: () => Promise<void>): { run: Promise<void>; lines: () => string[] } {
  const logs: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  const run = fn().finally(() => {
    console.log = orig
  })
  return { run, lines: () => logs }
}

const { triggerRun, showRun, cancelRun } = await import('../src/commands/run.js')
const { agentAttach, agentDetach } = await import('../src/commands/agent.js')

describe('run.ts — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('triggerRun: --format jsonl emits the same JSON as --format json (degrade), not human text', async () => {
    const created = { id: 'run-1', status: 'queued', kind: 'answer-visibility' }
    mockTriggerRun.mockResolvedValue(created)

    const jsonCap = captureLog(() => triggerRun('demo', { format: 'json' }))
    await jsonCap.run
    const jsonOut = jsonCap.lines().join('\n')

    mockTriggerRun.mockResolvedValue(created)
    const jsonlCap = captureLog(() => triggerRun('demo', { format: 'jsonl' }))
    await jsonlCap.run
    const jsonlOut = jsonlCap.lines().join('\n')

    // Machine output: parseable JSON equal to the json-format payload.
    expect(JSON.parse(jsonlOut)).toEqual(created)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    // Not the decorated human "Run created:" block.
    expect(jsonlOut).not.toContain('Run created:')
  })

  it('triggerRun: no-format human output is unchanged (decorated text, not JSON)', async () => {
    const created = { id: 'run-1', status: 'queued', kind: 'answer-visibility' }
    mockTriggerRun.mockResolvedValue(created)
    const cap = captureLog(() => triggerRun('demo', {}))
    await cap.run
    const out = cap.lines().join('\n')
    expect(out).toContain('Run created: run-1')
    expect(out).toContain('Status: queued')
    expect(() => JSON.parse(out)).toThrow()
  })

  it('showRun: --format jsonl emits the same JSON document as --format json', async () => {
    const detail = {
      id: 'run-9',
      status: 'completed',
      kind: 'answer-visibility',
      trigger: 'manual',
      createdAt: '2026-04-28T00:00:00.000Z',
    }
    mockGetRun.mockResolvedValue(detail)

    const jsonCap = captureLog(() => showRun('run-9', 'json'))
    await jsonCap.run
    const jsonOut = jsonCap.lines().join('\n')

    mockGetRun.mockResolvedValue(detail)
    const jsonlCap = captureLog(() => showRun('run-9', 'jsonl'))
    await jsonlCap.run
    const jsonlOut = jsonlCap.lines().join('\n')

    expect(JSON.parse(jsonlOut)).toEqual(detail)
    expect(jsonlOut).toBe(jsonOut)
    expect(jsonlOut).not.toContain('Run: run-9')
  })

  it('showRun: no-format human output is unchanged', async () => {
    const detail = {
      id: 'run-9',
      status: 'completed',
      kind: 'answer-visibility',
      trigger: 'manual',
      createdAt: '2026-04-28T00:00:00.000Z',
    }
    mockGetRun.mockResolvedValue(detail)
    const cap = captureLog(() => showRun('run-9', undefined))
    await cap.run
    const out = cap.lines().join('\n')
    expect(out).toContain('Run: run-9')
    expect(() => JSON.parse(out)).toThrow()
  })

  it('cancelRun: --format jsonl emits the same JSON document as --format json', async () => {
    const cancelled = { id: 'run-7', status: 'cancelled' }
    mockCancelRun.mockResolvedValue(cancelled)

    const jsonCap = captureLog(() => cancelRun('demo', 'run-7', 'json'))
    await jsonCap.run
    const jsonOut = jsonCap.lines().join('\n')

    mockCancelRun.mockResolvedValue(cancelled)
    const jsonlCap = captureLog(() => cancelRun('demo', 'run-7', 'jsonl'))
    await jsonlCap.run
    const jsonlOut = jsonlCap.lines().join('\n')

    expect(JSON.parse(jsonlOut)).toEqual(cancelled)
    expect(jsonlOut).toBe(jsonOut)
    expect(jsonlOut).not.toContain('cancelled.')
  })

  it('cancelRun: no-format human output is unchanged', async () => {
    const cancelled = { id: 'run-7', status: 'cancelled' }
    mockCancelRun.mockResolvedValue(cancelled)
    const cap = captureLog(() => cancelRun('demo', 'run-7', undefined))
    await cap.run
    const out = cap.lines().join('\n')
    expect(out).toBe('Run run-7 cancelled.')
    expect(() => JSON.parse(out)).toThrow()
  })
})

describe('agent.ts — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('agentAttach: --format jsonl emits the same JSON as --format json (degrade), not human text', async () => {
    mockListNotifications.mockResolvedValue([])
    mockCreateNotification.mockResolvedValue({ id: 'notif-1' })

    const jsonCap = captureLog(() =>
      agentAttach({ project: 'demo', url: 'https://hook.example/x', format: 'json' }),
    )
    await jsonCap.run
    const jsonOut = jsonCap.lines().join('\n')

    mockListNotifications.mockResolvedValue([])
    mockCreateNotification.mockResolvedValue({ id: 'notif-1' })
    const jsonlCap = captureLog(() =>
      agentAttach({ project: 'demo', url: 'https://hook.example/x', format: 'jsonl' }),
    )
    await jsonlCap.run
    const jsonlOut = jsonlCap.lines().join('\n')

    expect(JSON.parse(jsonlOut)).toEqual({
      status: 'attached',
      project: 'demo',
      notificationId: 'notif-1',
    })
    expect(jsonlOut).toBe(jsonOut)
    expect(jsonlOut).not.toContain('attached to')
  })

  it('agentAttach: no-format human output is unchanged', async () => {
    mockListNotifications.mockResolvedValue([])
    mockCreateNotification.mockResolvedValue({ id: 'notif-1' })
    const cap = captureLog(() =>
      agentAttach({ project: 'demo', url: 'https://hook.example/x' }),
    )
    await cap.run
    const out = cap.lines().join('\n')
    expect(out).toContain('Agent webhook attached to "demo"')
    expect(() => JSON.parse(out)).toThrow()
  })

  it('agentAttach (already attached): --format jsonl emits the same JSON as --format json', async () => {
    mockListNotifications.mockResolvedValue([{ id: 'n', source: 'agent' }])

    const jsonCap = captureLog(() =>
      agentAttach({ project: 'demo', url: 'https://hook.example/x', format: 'json' }),
    )
    await jsonCap.run
    const jsonOut = jsonCap.lines().join('\n')

    mockListNotifications.mockResolvedValue([{ id: 'n', source: 'agent' }])
    const jsonlCap = captureLog(() =>
      agentAttach({ project: 'demo', url: 'https://hook.example/x', format: 'jsonl' }),
    )
    await jsonlCap.run
    const jsonlOut = jsonlCap.lines().join('\n')

    expect(JSON.parse(jsonlOut)).toEqual({ status: 'already-attached', project: 'demo' })
    expect(jsonlOut).toBe(jsonOut)
  })

  it('agentDetach: --format jsonl emits the same JSON as --format json (degrade), not human text', async () => {
    mockListNotifications.mockResolvedValue([{ id: 'n1', source: 'agent' }])
    mockDeleteNotification.mockResolvedValue(undefined)

    const jsonCap = captureLog(() => agentDetach({ project: 'demo', format: 'json' }))
    await jsonCap.run
    const jsonOut = jsonCap.lines().join('\n')

    mockListNotifications.mockResolvedValue([{ id: 'n1', source: 'agent' }])
    mockDeleteNotification.mockResolvedValue(undefined)
    const jsonlCap = captureLog(() => agentDetach({ project: 'demo', format: 'jsonl' }))
    await jsonlCap.run
    const jsonlOut = jsonlCap.lines().join('\n')

    expect(JSON.parse(jsonlOut)).toEqual({ status: 'detached', project: 'demo' })
    expect(jsonlOut).toBe(jsonOut)
    expect(jsonlOut).not.toContain('detached from')
  })

  it('agentDetach: no-format human output is unchanged', async () => {
    mockListNotifications.mockResolvedValue([{ id: 'n1', source: 'agent' }])
    mockDeleteNotification.mockResolvedValue(undefined)
    const cap = captureLog(() => agentDetach({ project: 'demo' }))
    await cap.run
    const out = cap.lines().join('\n')
    expect(out).toContain('Agent webhook detached from "demo"')
    expect(() => JSON.parse(out)).toThrow()
  })
})
