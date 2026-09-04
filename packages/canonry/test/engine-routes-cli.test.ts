import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EngineConnectionModelCatalogResponse,
  EngineConnectionPublicDto,
  EngineRouteConfig,
  EngineRouteSummaryResponse,
} from '@ainyc/canonry-contracts'

const mockGetEngineRouteSummaries = vi.fn()
const mockUpsertEngineConnection = vi.fn()
const mockGetEngineConnectionModelCatalog = vi.fn()
const mockUpsertEngineRoute = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getEngineRouteSummaries: mockGetEngineRouteSummaries,
    upsertEngineConnection: mockUpsertEngineConnection,
    getEngineConnectionModelCatalog: mockGetEngineConnectionModelCatalog,
    upsertEngineRoute: mockUpsertEngineRoute,
  }),
}))

function captureOutput(fn: () => Promise<void>): { run: Promise<void>; text: () => string; lines: () => string[] } {
  let output = ''
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output += `${args.join(' ')}\n`
  })
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  })
  const run = fn().finally(() => {
    log.mockRestore()
    write.mockRestore()
  })
  return { run, text: () => output, lines: () => output.split('\n').filter(Boolean) }
}

const routeSummaries: EngineRouteSummaryResponse = {
  routes: [{
    id: 'route:research-gateway',
    label: 'Research gateway',
    modelId: 'meta/llama-4',
    revision: 2,
    source: 'configured',
    readiness: { state: 'text-ready', measurementReady: false },
  }],
}

const connection: EngineConnectionPublicDto = {
  id: 'gateway:team',
  label: 'Team gateway',
  preset: 'litellm',
  protocol: 'openai-compatible',
  baseUrl: 'https://gateway.example/v1',
  quota: { maxConcurrency: 2, maxRequestsPerMinute: 60, maxRequestsPerDay: 600 },
  secretConfigured: true,
}

const modelCatalog: EngineConnectionModelCatalogResponse = {
  connectionId: 'gateway:team',
  state: 'available',
  manualModelIdAllowed: true,
  fetchedAt: '2026-09-01T12:00:00.000Z',
  models: [{ id: 'meta/llama-4', displayName: 'Llama 4', provider: 'Meta' }],
}

const route: EngineRouteConfig = {
  id: 'route:research-gateway',
  label: 'Research gateway',
  connectionId: 'gateway:team',
  modelId: 'meta/llama-4',
  revision: 2,
  source: 'configured',
  capabilities: { kind: 'text-only' },
}

const {
  listEngineConnectionModels,
  listEngineRoutes,
  upsertEngineConnection,
  upsertEngineRoute,
} = await import('../src/commands/settings.js')
const { SETTINGS_CLI_COMMANDS } = await import('../src/cli-commands/settings.js')

describe('engine route settings commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetEngineRouteSummaries.mockResolvedValue(routeSummaries)
    mockUpsertEngineConnection.mockResolvedValue(connection)
    mockGetEngineConnectionModelCatalog.mockResolvedValue(modelCatalog)
    mockUpsertEngineRoute.mockResolvedValue(route)
  })

  it('lists only safe route summaries and keeps JSONL as one complete compact document', async () => {
    const cap = captureOutput(() => listEngineRoutes('jsonl'))
    await cap.run

    expect(mockGetEngineRouteSummaries).toHaveBeenCalledOnce()
    expect(cap.lines()).toHaveLength(1)
    expect(JSON.parse(cap.lines()[0]!)).toEqual(routeSummaries)
    expect(cap.text()).not.toContain('gateway.example')
    expect(cap.text()).not.toContain('apiKey')
  })

  it('sends a supplied connection key only on the write and never echoes it', async () => {
    const apiKey = 'do-not-echo-this-secret'
    const cap = captureOutput(() => upsertEngineConnection('gateway:team', {
      label: 'Team gateway',
      preset: 'litellm',
      protocol: 'openai-compatible',
      apiKey,
      quota: { maxConcurrency: 2, maxRequestsPerMinute: 60, maxRequestsPerDay: 600 },
    }, 'json'))
    await cap.run

    expect(mockUpsertEngineConnection).toHaveBeenCalledWith('gateway:team', expect.objectContaining({ apiKey }))
    expect(JSON.parse(cap.text())).toEqual(connection)
    expect(cap.text()).not.toContain(apiKey)
  })

  it('preserves a missing apiKey field for the server-side credential-preserving upsert', async () => {
    await upsertEngineConnection('gateway:team', {
      label: 'Team gateway',
      preset: 'litellm',
      protocol: 'openai-compatible',
      quota: { maxConcurrency: 2, maxRequestsPerMinute: 60, maxRequestsPerDay: 600 },
    })

    expect(mockUpsertEngineConnection).toHaveBeenCalledWith('gateway:team', expect.not.objectContaining({ apiKey: expect.anything() }))
  })

  it('shows catalog models and the manual-model fallback without exposing credentials', async () => {
    const cap = captureOutput(() => listEngineConnectionModels('gateway:team'))
    await cap.run

    expect(mockGetEngineConnectionModelCatalog).toHaveBeenCalledWith('gateway:team')
    expect(cap.text()).toContain('meta/llama-4')
    expect(cap.text()).toContain('Manual model IDs remain available')
    expect(cap.text()).not.toContain('do-not-echo-this-secret')
  })

  it('keeps an unavailable catalog as a normal manual-entry state in JSONL', async () => {
    const unavailable: EngineConnectionModelCatalogResponse = {
      ...modelCatalog,
      state: 'unavailable',
      models: [],
    }
    mockGetEngineConnectionModelCatalog.mockResolvedValue(unavailable)

    const cap = captureOutput(() => listEngineConnectionModels('gateway:team', 'jsonl'))
    await cap.run

    expect(cap.lines()).toHaveLength(1)
    expect(JSON.parse(cap.lines()[0]!)).toEqual(unavailable)
  })

  it('upserts a route as text-only and tells operators it cannot run sweeps', async () => {
    const cap = captureOutput(() => upsertEngineRoute('route:research-gateway', {
      label: 'Research gateway',
      connectionId: 'gateway:team',
      modelId: 'meta/llama-4',
    }))
    await cap.run

    expect(mockUpsertEngineRoute).toHaveBeenCalledWith('route:research-gateway', {
      label: 'Research gateway',
      connectionId: 'gateway:team',
      modelId: 'meta/llama-4',
    })
    expect(cap.text()).toContain('text-only')
    expect(cap.text()).toContain('cannot run an answer-visibility sweep')
  })

  it('requires all connection policy fields before making an upsert request', async () => {
    const command = SETTINGS_CLI_COMMANDS.find(spec => spec.path.join(' ') === 'settings engine-connection')!
    await expect(command.run({
      positionals: ['gateway:team'],
      values: { label: 'Team gateway', preset: 'litellm', 'max-concurrent': '2', 'max-per-minute': '60' },
      format: 'json',
      dryRun: false,
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(mockUpsertEngineConnection).not.toHaveBeenCalled()
  })

  it('rejects a custom connection without an explicit endpoint before making an upsert request', async () => {
    const command = SETTINGS_CLI_COMMANDS.find(spec => spec.path.join(' ') === 'settings engine-connection')!
    await expect(command.run({
      positionals: ['gateway:team'],
      values: {
        label: 'Team gateway',
        preset: 'custom-openai-compatible',
        'max-concurrent': '2',
        'max-per-minute': '60',
        'max-per-day': '600',
      },
      format: 'json',
      dryRun: false,
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(mockUpsertEngineConnection).not.toHaveBeenCalled()
  })
})
