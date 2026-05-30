import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { AgentMemoryListResponse, AgentProvidersResponse } from '@ainyc/canonry-contracts'

const mockListAgentMemory = vi.fn()
const mockSetAgentMemory = vi.fn()
const mockForgetAgentMemory = vi.fn()
const mockListAgentProviders = vi.fn()
const mockGetAgentTranscript = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    listAgentMemory: mockListAgentMemory,
    setAgentMemory: mockSetAgentMemory,
    forgetAgentMemory: mockForgetAgentMemory,
    listAgentProviders: mockListAgentProviders,
    getAgentTranscript: mockGetAgentTranscript,
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

const { agentMemoryList, agentMemorySet, agentMemoryForget } = await import(
  '../src/commands/agent-memory.js'
)
const { agentProviders } = await import('../src/commands/agent-providers.js')
const { agentTranscript } = await import('../src/commands/agent-transcript.js')

const memoryResponse: AgentMemoryListResponse = {
  entries: [
    {
      id: 'm1',
      key: 'last-regression',
      value: 'OpenAI dropped citation for query X',
      source: 'aero',
      updatedAt: '2026-04-28T00:00:00.000Z',
    },
    {
      id: 'm2',
      key: 'icp',
      value: 'B2B SaaS marketers',
      source: 'user',
      updatedAt: '2026-04-29T00:00:00.000Z',
    },
  ],
}

const providersResponse: AgentProvidersResponse = {
  defaultProvider: 'claude',
  providers: [
    {
      id: 'claude',
      label: 'Anthropic (Claude)',
      defaultModel: 'claude-opus-4-8',
      configured: true,
      keySource: 'config',
    },
    {
      id: 'openai',
      label: 'OpenAI',
      defaultModel: 'gpt-5',
      configured: false,
      keySource: null,
    },
  ],
}

describe('agent memory list — jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits one self-contained note per line, tagged with project', async () => {
    mockListAgentMemory.mockResolvedValue(memoryResponse)
    const cap = captureStdout(() => agentMemoryList({ project: 'demo', format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map((l) => JSON.parse(l))
    // Every line parses on its own and carries the injected project context.
    expect(records.every((r) => r.project === 'demo')).toBe(true)
    expect(records[0]).toMatchObject({
      project: 'demo',
      key: 'last-regression',
      value: 'OpenAI dropped citation for query X',
      source: 'aero',
    })
    expect(records[1]).toMatchObject({ project: 'demo', key: 'icp', source: 'user' })
  })

  it('empty collection writes nothing', async () => {
    mockListAgentMemory.mockResolvedValue({ entries: [] })
    const cap = captureStdout(() => agentMemoryList({ project: 'demo', format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('format=json is unchanged — prints the full envelope exactly', async () => {
    mockListAgentMemory.mockResolvedValue(memoryResponse)
    const cap = captureLog(() => agentMemoryList({ project: 'demo', format: 'json' }))
    await cap.run
    expect(JSON.parse(cap.lines().join(''))).toEqual(memoryResponse)
  })
})

describe('agent providers — jsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits one provider per line, tagged with project + defaultProvider', async () => {
    mockListAgentProviders.mockResolvedValue(providersResponse)
    const cap = captureStdout(() => agentProviders({ project: 'demo', format: 'jsonl' }))
    await cap.run
    const lines = cap.lines()
    expect(lines).toHaveLength(2)
    const records = lines.map((l) => JSON.parse(l))
    // Each line keeps which provider is the default even when lifted out.
    expect(records.every((r) => r.project === 'demo')).toBe(true)
    expect(records.every((r) => r.defaultProvider === 'claude')).toBe(true)
    expect(records[0]).toMatchObject({
      project: 'demo',
      defaultProvider: 'claude',
      id: 'claude',
      configured: true,
      keySource: 'config',
    })
    expect(records[1]).toMatchObject({ project: 'demo', id: 'openai', configured: false })
  })

  it('record fields win over context (id is the provider id, not overwritten)', async () => {
    mockListAgentProviders.mockResolvedValue(providersResponse)
    const cap = captureStdout(() => agentProviders({ project: 'demo', format: 'jsonl' }))
    await cap.run
    const records = cap.lines().map((l) => JSON.parse(l))
    expect(records.map((r) => r.id)).toEqual(['claude', 'openai'])
  })

  it('empty collection writes nothing', async () => {
    mockListAgentProviders.mockResolvedValue({ defaultProvider: null, providers: [] })
    const cap = captureStdout(() => agentProviders({ project: 'demo', format: 'jsonl' }))
    await cap.run
    expect(cap.lines()).toHaveLength(0)
  })

  it('format=json is unchanged — prints the full envelope exactly', async () => {
    mockListAgentProviders.mockResolvedValue(providersResponse)
    const cap = captureLog(() => agentProviders({ project: 'demo', format: 'json' }))
    await cap.run
    expect(JSON.parse(cap.lines().join(''))).toEqual(providersResponse)
  })
})

describe('agent mutations / transcript — jsonl routes to machine output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('agent memory set --format jsonl emits the single JSON object, not human text', async () => {
    const setResult = {
      status: 'ok' as const,
      entry: {
        id: 'm1',
        key: 'icp',
        value: 'B2B SaaS marketers',
        source: 'user' as const,
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
    }
    mockSetAgentMemory.mockResolvedValue(setResult)
    const cap = captureLog(() =>
      agentMemorySet({ project: 'demo', key: 'icp', value: 'B2B SaaS marketers', format: 'jsonl' }),
    )
    await cap.run
    const out = cap.lines().join('\n')
    // Machine output: parseable JSON, not the "Stored note ..." human string.
    expect(out).not.toContain('Stored note')
    expect(JSON.parse(out)).toEqual(setResult)
  })

  it('agent memory forget --format jsonl emits the single JSON object', async () => {
    const forgetResult = { status: 'forgotten' as const, key: 'icp' }
    mockForgetAgentMemory.mockResolvedValue(forgetResult)
    const cap = captureLog(() =>
      agentMemoryForget({ project: 'demo', key: 'icp', format: 'jsonl' }),
    )
    await cap.run
    const out = cap.lines().join('\n')
    expect(out).not.toContain('Forgot note')
    expect(JSON.parse(out)).toEqual(forgetResult)
  })

  it('agent transcript --format jsonl emits the transcript JSON, not human text', async () => {
    const transcript = {
      modelProvider: 'claude',
      modelId: 'claude-opus-4-8',
      updatedAt: '2026-04-29T00:00:00.000Z',
      messages: [{ role: 'user', content: 'hi' }],
    }
    mockGetAgentTranscript.mockResolvedValue(transcript)
    const cap = captureLog(() => agentTranscript({ project: 'demo', format: 'jsonl' }))
    await cap.run
    const out = cap.lines().join('\n')
    expect(out).not.toContain('Aero session for')
    expect(JSON.parse(out)).toEqual(transcript)
  })
})
