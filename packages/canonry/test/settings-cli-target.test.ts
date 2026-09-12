import { describe, expect, it, vi } from 'vitest'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'

const setGoogleAuth = vi.fn()
const setProvider = vi.fn()

vi.mock('../src/commands/settings.js', () => ({
  setGoogleAuth,
  setProvider,
  showSettings: vi.fn(),
}))

const { SETTINGS_CLI_COMMANDS } = await import('../src/cli-commands/settings.js')

describe('settings google CLI target', () => {
  it('forwards an explicit server target and JSON format', async () => {
    await dispatchRegisteredCommand([
      'settings', 'google', '--client-id', 'client-id', '--client-secret', 'client-secret',
      '--target', 'server', '--format', 'json',
    ], 'human', SETTINGS_CLI_COMMANDS)

    expect(setGoogleAuth).toHaveBeenCalledWith({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      target: 'server',
      format: 'json',
    })
  })

  it('rejects an invalid target', async () => {
    await expect(dispatchRegisteredCommand([
      'settings', 'google', '--client-id', 'client-id', '--client-secret', 'client-secret', '--target', 'remote',
    ], 'human', SETTINGS_CLI_COMMANDS)).rejects.toThrow('invalid --target')
  })

  it('forwards model-only provider edits so the server can apply its configured-provider check', async () => {
    await dispatchRegisteredCommand([
      'settings', 'provider', 'openai', '--model', 'gpt-4.1', '--format', 'json',
    ], 'human', SETTINGS_CLI_COMMANDS)

    expect(setProvider).toHaveBeenCalledWith('openai', {
      apiKey: undefined,
      baseUrl: undefined,
      model: 'gpt-4.1',
      quota: undefined,
      format: 'json',
    })
  })
})
