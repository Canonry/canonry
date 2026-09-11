import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockGetSettings = vi.fn()
const mockUpdateProvider = vi.fn()
const mockUpdateGoogleSettings = vi.fn()
const mockSaveConfigPatch = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getSettings: mockGetSettings,
    updateProvider: mockUpdateProvider,
    updateGoogleSettings: mockUpdateGoogleSettings,
  }),
}))

vi.mock('../src/config.js', () => ({
  loadConfig: () => ({ google: { clientId: 'cid', clientSecret: 'secret' } }),
  saveConfigPatch: mockSaveConfigPatch,
  getConfigPath: () => '/tmp/canonry/config.yaml',
}))

/** Capture console.log lines (the json / jsonl degrade path uses console.log). */
function captureLog(fn: () => Promise<void> | void): Promise<string> {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return Promise.resolve(fn())
    .finally(() => {
      console.log = origLog
    })
    .then(() => logs.join('\n'))
}

const { showSettings, setGoogleAuth, setProvider } = await import('../src/commands/settings.js')

const settings = {
  providers: [
    { name: 'openai', model: 'gpt-x', configured: true, quota: { maxConcurrency: 1, maxRequestsPerMinute: 2, maxRequestsPerDay: 3 } },
    { name: 'gemini', configured: false },
  ],
  providerCatalog: [],
  google: { configured: false },
  bing: { configured: true },
}

describe('showSettings — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSettings.mockResolvedValue(settings)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => showSettings('json'))
    const jsonlOut = await captureLog(() => showSettings('jsonl'))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    expect(JSON.parse(jsonlOut)).toEqual(settings)
  })

  it('format=jsonl does NOT print the human settings table', async () => {
    const out = await captureLog(() => showSettings('jsonl'))
    expect(out).not.toMatch(/Provider settings:/)
    expect(out).not.toMatch(/Google OAuth:/)
  })

  it('no format → human text output is unchanged', async () => {
    const out = await captureLog(() => showSettings(undefined))
    expect(out).toMatch(/Provider settings:/)
    expect(out).toMatch(/Google OAuth:/)
    expect(out).toMatch(/not configured/)
    expect(() => JSON.parse(out)).toThrow()
  })
})

describe('setGoogleAuth — explicit target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateGoogleSettings.mockResolvedValue({ configured: true })
  })

  it('updates the server without persisting the local config, including JSON output', async () => {
    const out = await captureLog(() => setGoogleAuth({
      clientId: 'server-client-id',
      clientSecret: 'server-client-secret',
      target: 'server',
      format: 'json',
    }))

    expect(mockUpdateGoogleSettings).toHaveBeenCalledWith({
      clientId: 'server-client-id',
      clientSecret: 'server-client-secret',
    })
    expect(mockSaveConfigPatch).not.toHaveBeenCalled()
    expect(JSON.parse(out)).toEqual({ configured: true })
  })
})

describe('setProvider — jsonl degrades to the json document', () => {
  const result = {
    name: 'openai',
    model: 'gpt-x',
    configured: true,
    quota: { maxConcurrency: 1, maxRequestsPerMinute: 2, maxRequestsPerDay: 3 },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateProvider.mockResolvedValue(result)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => setProvider('openai', { format: 'json' }))
    const jsonlOut = await captureLog(() => setProvider('openai', { format: 'jsonl' }))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(result)
  })

  it('no format → human text output is unchanged', async () => {
    const out = await captureLog(() => setProvider('openai', {}))
    expect(out).toMatch(/Provider openai updated successfully\./)
    expect(() => JSON.parse(out)).toThrow()
  })
})
