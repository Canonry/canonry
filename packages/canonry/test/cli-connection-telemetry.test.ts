import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/telemetry.js')>(),
  trackEvent,
}))
const client = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  createNotification: vi.fn(),
  deleteNotification: vi.fn(),
  reloadProviders: vi.fn(),
}))
vi.mock('../src/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/client.js')>(),
  createApiClient: () => client,
}))

const { agentAttach, agentDetach } = await import('../src/commands/agent.js')
const { cdpConnect } = await import('../src/commands/cdp.js')
const { bootstrapCommand } = await import('../src/commands/bootstrap.js')
const { initCommand } = await import('../src/commands/init.js')

const connections = () => trackEvent.mock.calls
  .filter(([event]) => event === 'integration.connection')
  .map(([, properties, options]) => [properties, options])

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-cli-connection-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', dir)
  vi.stubEnv('CANONRY_AGENT', 'codex')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  trackEvent.mockReset()
  for (const fn of Object.values(client)) fn.mockReset()
  // No server is running for bootstrap to reload.
  client.reloadProviders.mockRejectedValue(new Error('no server'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeConfig(extra: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(dir, 'config.yaml'), stringify({
    apiUrl: 'http://127.0.0.1:1', database: path.join(dir, 'data.db'), apiKey: 'cnry_test', ...extra,
  }), 'utf-8')
}

describe('agent webhook attempts the server never sees', () => {
  it('reports an attach to a project that already has one, and a detach with none, as cancelled', async () => {
    writeConfig()
    client.listNotifications.mockResolvedValue([{ id: 'n-1', source: 'agent' }])
    await agentAttach({ project: 'acme', url: 'https://agent.example/hook', format: 'json' })
    client.listNotifications.mockResolvedValue([])
    await agentDetach({ project: 'acme', format: 'json' })

    expect(connections()).toEqual([
      [{ integration: 'agent_webhook', action: 'connect', status: 'cancelled', reasonCode: 'ALREADY_CONNECTED', surface: 'cli', agent: 'codex' }, { errorCode: 'ALREADY_CONNECTED' }],
      [{ integration: 'agent_webhook', action: 'disconnect', status: 'cancelled', reasonCode: 'NOT_CONNECTED', surface: 'cli', agent: 'codex' }, { errorCode: 'NOT_CONNECTED' }],
    ])
  })

  it('leaves a real attach and detach to the server, which reports them', async () => {
    writeConfig()
    client.listNotifications.mockResolvedValue([])
    client.createNotification.mockResolvedValue({ id: 'n-2' })
    await agentAttach({ project: 'acme', url: 'https://agent.example/hook', format: 'json' })
    client.listNotifications.mockResolvedValue([{ id: 'n-2', source: 'agent' }])
    await agentDetach({ project: 'acme', format: 'json' })

    expect(connections()).toEqual([])
  })
})

describe('CDP endpoint saved by the CLI', () => {
  it('reports the save as a connection from the CLI', async () => {
    writeConfig()
    await cdpConnect({ host: 'localhost', port: '9333', format: 'json' })

    expect(connections()).toEqual([
      [{ integration: 'cdp', action: 'connect', status: 'succeeded', surface: 'cli', agent: 'codex' }, undefined],
    ])
  })

  // File modes do not stop root, which would make the write succeed and the test meaningless.
  it.skipIf(process.getuid?.() === 0)('reports a save the config refuses as failed', async () => {
    writeConfig()
    fs.chmodSync(path.join(dir, 'config.yaml'), 0o444)
    fs.chmodSync(dir, 0o555)
    try {
      await expect(cdpConnect({ host: 'localhost', format: 'json' })).rejects.toThrow()
    } finally {
      fs.chmodSync(dir, 0o755)
      fs.chmodSync(path.join(dir, 'config.yaml'), 0o644)
    }
    expect(connections()).toEqual([
      [{ integration: 'cdp', action: 'connect', status: 'failed', reasonCode: 'UNKNOWN', errorName: 'Error', surface: 'cli', agent: 'codex' }, { errorCode: 'UNKNOWN' }],
    ])
  })
})

describe('provider keys stored by bootstrap and init', () => {
  beforeEach(() => {
    for (const name of [
      'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_VERTEX_PROJECT', 'GEMINI_VERTEX_REGION', 'GEMINI_VERTEX_CREDENTIALS',
      'OPENAI_API_KEY', 'OPENAI_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'PERPLEXITY_API_KEY', 'PERPLEXITY_MODEL',
      'MUSE_API_KEY', 'MUSE_MODEL', 'LOCAL_BASE_URL', 'LOCAL_API_KEY', 'LOCAL_MODEL', 'CANONRY_API_KEY', 'CANONRY_DATABASE_PATH',
    ]) vi.stubEnv(name, undefined)
    vi.stubEnv('CANONRY_API_URL', 'http://127.0.0.1:1')
  })

  it('reports a provider bootstrap adds as a connect, one whose key it changes as a reauth, and an unchanged rerun as nothing', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'gemini-key-1')
    await bootstrapCommand({ format: 'json' }).catch(() => {})
    await bootstrapCommand({ format: 'json' }).catch(() => {})
    vi.stubEnv('GEMINI_API_KEY', 'gemini-key-2')
    vi.stubEnv('OPENAI_API_KEY', 'openai-key-1')
    await bootstrapCommand({ format: 'json' }).catch(() => {})

    expect(connections()).toEqual([
      [{ integration: 'provider', provider: 'gemini', action: 'connect', status: 'succeeded', surface: 'cli', agent: 'codex' }, undefined],
      [{ integration: 'provider', provider: 'gemini', action: 'reauth', status: 'succeeded', surface: 'cli', agent: 'codex' }, undefined],
      [{ integration: 'provider', provider: 'openai', action: 'connect', status: 'succeeded', surface: 'cli', agent: 'codex' }, undefined],
    ])
  })

  it('reports every provider init stores, once telemetry is on', async () => {
    vi.stubEnv('CANONRY_TELEMETRY_DISABLED', undefined)
    vi.stubEnv('DO_NOT_TRACK', undefined)
    vi.stubEnv('CI', undefined)
    await initCommand({ geminiKey: 'gemini-flag-key', claudeKey: 'claude-flag-key', skipSkills: true, skipMcp: true, format: 'json' })

    expect(trackEvent.mock.calls.map(([event]) => event)).toEqual(['cli.init', 'integration.connection', 'integration.connection'])
    expect(connections()).toEqual([
      // A fresh config: each provider's first successful connection is marked.
      [{ integration: 'provider', provider: 'gemini', action: 'connect', status: 'succeeded', surface: 'cli', agent: 'codex', first: true }, undefined],
      [{ integration: 'provider', provider: 'claude', action: 'connect', status: 'succeeded', surface: 'cli', agent: 'codex', first: true }, undefined],
    ])
  })
})
