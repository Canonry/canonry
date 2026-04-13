import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { stringify } from 'yaml'

// Mock the client module before importing agent commands
const mockListNotifications = vi.fn()
const mockCreateNotification = vi.fn()
const mockDeleteNotification = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listNotifications: mockListNotifications,
    createNotification: mockCreateNotification,
    deleteNotification: mockDeleteNotification,
  }),
}))

const { agentAttach, agentDetach } = await import('../src/commands/agent.js')

let tmpDir: string
const origConfigDir = process.env.CANONRY_CONFIG_DIR

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-attach-'))
  process.env.CANONRY_CONFIG_DIR = tmpDir

  // Write minimal config with agent section
  const config = {
    apiUrl: 'http://localhost:4100',
    database: path.join(tmpDir, 'canonry.db'),
    apiKey: 'cnry_test',
    agent: { binary: '/usr/local/bin/openclaw', profile: 'aero', gatewayPort: 3579 },
  }
  fs.writeFileSync(path.join(tmpDir, 'config.yaml'), stringify(config), 'utf-8')

  vi.clearAllMocks()
})

afterEach(() => {
  if (origConfigDir === undefined) {
    delete process.env.CANONRY_CONFIG_DIR
  } else {
    process.env.CANONRY_CONFIG_DIR = origConfigDir
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('agentAttach', () => {
  it('creates webhook when none exists', async () => {
    mockListNotifications.mockResolvedValue([])
    mockCreateNotification.mockResolvedValue({ id: 'notif-1' })

    const output = await captureStdout(() =>
      agentAttach({ project: 'my-project', format: 'json' }),
    )

    const parsed = JSON.parse(output)
    expect(parsed.status).toBe('attached')
    expect(parsed.project).toBe('my-project')
    expect(parsed.notificationId).toBe('notif-1')

    expect(mockCreateNotification).toHaveBeenCalledWith('my-project', {
      channel: 'webhook',
      url: 'http://localhost:3579/hooks/canonry',
      events: ['run.completed', 'insight.critical', 'insight.high', 'citation.gained'],
      source: 'agent',
    })
  })

  it('is idempotent when webhook already exists', async () => {
    mockListNotifications.mockResolvedValue([
      { id: 'existing-1', url: 'http://localhost:3579/redacted', urlHost: 'localhost:3579', source: 'agent' },
    ])

    const output = await captureStdout(() =>
      agentAttach({ project: 'my-project', format: 'json' }),
    )

    const parsed = JSON.parse(output)
    expect(parsed.status).toBe('already-attached')
    expect(mockCreateNotification).not.toHaveBeenCalled()
  })

  it('outputs human-readable text without --format json', async () => {
    mockListNotifications.mockResolvedValue([])
    mockCreateNotification.mockResolvedValue({ id: 'notif-2' })

    const output = await captureStdout(() =>
      agentAttach({ project: 'my-project' }),
    )

    expect(output).toContain('Agent webhook attached')
    expect(output).toContain('my-project')
  })
})

describe('agentDetach', () => {
  it('removes the agent webhook', async () => {
    mockListNotifications.mockResolvedValue([
      { id: 'notif-1', url: 'http://localhost:3579/redacted', urlHost: 'localhost:3579', source: 'agent' },
    ])
    mockDeleteNotification.mockResolvedValue(undefined)

    const output = await captureStdout(() =>
      agentDetach({ project: 'my-project', format: 'json' }),
    )

    const parsed = JSON.parse(output)
    expect(parsed.status).toBe('detached')
    expect(mockDeleteNotification).toHaveBeenCalledWith('my-project', 'notif-1')
  })

  it('reports not-attached when no agent webhook found', async () => {
    mockListNotifications.mockResolvedValue([
      { id: 'other', url: 'https://example.com/webhook' },
    ])

    const output = await captureStdout(() =>
      agentDetach({ project: 'my-project', format: 'json' }),
    )

    const parsed = JSON.parse(output)
    expect(parsed.status).toBe('not-attached')
    expect(mockDeleteNotification).not.toHaveBeenCalled()
  })

  it('outputs human-readable text without --format json', async () => {
    mockListNotifications.mockResolvedValue([])

    const output = await captureStdout(() =>
      agentDetach({ project: 'my-project' }),
    )

    expect(output).toContain('No agent webhook found')
    expect(output).toContain('my-project')
  })
})

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(' '))
  }
  try {
    await fn()
  } finally {
    console.log = originalLog
  }
  return chunks.join('\n')
}
