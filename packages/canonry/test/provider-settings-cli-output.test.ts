import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConnectionSettingsDto } from '@canonry/canonry-contracts'
import * as clientModule from '../src/client.js'
import { showProviderSettings } from '../src/commands/settings.js'
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
})
