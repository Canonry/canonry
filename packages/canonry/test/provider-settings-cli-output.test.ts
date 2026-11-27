import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConnectionSettingsDto, SettingsDto } from '@canonry/canonry-contracts'
import * as clientModule from '../src/client.js'
import { showProviderSettings, showSettings } from '../src/commands/settings.js'
import { providerSettingsFixture } from './fixtures/provider-connection.js'

function printed(connection: ProviderConnectionSettingsDto): Promise<string[]> {
  const api = new clientModule.ApiClient('https://canonry.test', 'cnry_settings-read', { skipProbe: true })
  vi.spyOn(api, 'getProviderSettings').mockResolvedValue(connection)
  vi.spyOn(clientModule, 'createApiClient').mockReturnValue(api)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  return showProviderSettings('openai').then(() => log.mock.calls.map(call => String(call[0])))
}

afterEach(() => { vi.restoreAllMocks() })

describe('canonry settings provider-info human output', () => {
  it('lists projects whose usage could not be read, apart from the counted projects', async () => {
    const lines = await printed({
      ...providerSettingsFixture,
      usage: {
        ...providerSettingsFixture.usage,
        unknown: { projectCount: 2, projects: [
          { name: 'harbor', displayName: 'Harbor Resorts', sources: ['measurement-plan', 'schedule'] },
          { name: 'acme', displayName: 'Acme', sources: ['measurement-draft'] },
        ] },
      },
    })
    expect(lines).toContain('  Used by 1 projects:')
    expect(lines).toContain('    Demo (demo): openai · project')
    expect(lines).toContain('  Usage unknown for 2 projects (saved settings could not be read):')
    expect(lines).toContain('    Harbor Resorts (harbor): measurement-plan, schedule')
    expect(lines).toContain('    Acme (acme): measurement-draft')
  })

  it('says nothing about unknown usage when every project could be read', async () => {
    const lines = await printed(providerSettingsFixture)
    expect(lines.some(line => line.includes('Usage unknown'))).toBe(false)
  })

  it('uses the singular for one unreadable project', async () => {
    const lines = await printed({
      ...providerSettingsFixture,
      usage: { ...providerSettingsFixture.usage, unknown: { projectCount: 1, projects: [{ name: 'acme', displayName: 'Acme', sources: ['measurement-draft'] }] } },
    })
    expect(lines).toContain('  Usage unknown for 1 project (saved settings could not be read):')
  })

  it.each([
    {
      case: 'a passing test of the active settings',
      lastTest: { status: 'connected' as const, ok: true, message: 'openai api key verified', model: 'gpt-old', checkedAt: '2026-11-08T10:00:00.000Z', durationMs: 900 },
      line: '  Last test: connected at 2026-11-08T10:00:00.000Z',
    },
    {
      case: 'a failed test, with its reason',
      lastTest: { status: 'failed' as const, ok: false, message: '401 Incorrect API key provided', model: 'gpt-old', checkedAt: '2026-11-08T10:00:00.000Z', durationMs: 120 },
      line: '  Last test: failed at 2026-11-08T10:00:00.000Z (401 Incorrect API key provided)',
    },
    {
      case: 'no test since the settings changed',
      lastTest: null,
      line: '  Last test: none since these settings changed; run "canonry settings provider test openai"',
    },
  ])('prints the last test: $case', async ({ lastTest, line }) => {
    const lines = await printed({ ...providerSettingsFixture, lastTest })
    expect(lines).toContain(line)
  })

  it('prints no last test line for a host that keeps no test history', async () => {
    const lines = await printed(providerSettingsFixture)
    expect(lines.some(line => line.includes('Last test'))).toBe(false)
  })
})

describe('canonry settings human output', () => {
  it('prints each configured provider\'s last test from the connection details', async () => {
    const settings: SettingsDto = {
      providers: [{ name: 'openai', configured: true, model: 'gpt-old' }],
      providerCatalog: [],
      providerConnections: [{
        ...providerSettingsFixture,
        lastTest: { status: 'connected', ok: true, message: 'openai api key verified', model: 'gpt-old', checkedAt: '2026-11-08T10:00:00.000Z', durationMs: 900 },
      }],
      google: { configured: false },
      bing: { configured: false },
    }
    const api = new clientModule.ApiClient('https://canonry.test', 'cnry_settings-read', { skipProbe: true })
    vi.spyOn(api, 'getSettings').mockResolvedValue(settings)
    vi.spyOn(clientModule, 'createApiClient').mockReturnValue(api)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await showSettings()
    expect(log.mock.calls.map(call => String(call[0]))).toContain('    Last test: connected at 2026-11-08T10:00:00.000Z')
  })
})

