import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { createClient, migrate, users } from '@ainyc/canonry-db'
import { DASHBOARD_CLI_COMMANDS } from '../src/cli-commands/dashboard.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { clearDashboardPassword, getConfigPath, loadConfig, saveConfigPatch } from '../src/config.js'

const PASSWORD_HASH = 'deadbeef'.repeat(8)

let configDir: string

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-dashboard-password-reset-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', configDir)
  for (const key of ['CANONRY_PORT', 'CANONRY_BASE_PATH', 'CANONRY_API_URL', 'CANONRY_API_KEY', 'CANONRY_DATABASE_PATH']) {
    vi.stubEnv(key, undefined)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(configDir, { recursive: true, force: true })
})

function baseConfig() {
  return {
    apiUrl: 'http://127.0.0.1:4999',
    database: path.join(configDir, 'canonry.sqlite'),
    apiKey: 'cnry_reset_fixture',
  }
}

function writeConfig(extra: Record<string, unknown> = { dashboardPasswordHash: PASSWORD_HASH }) {
  fs.writeFileSync(getConfigPath(), stringify({ ...baseConfig(), ...extra }), { mode: 0o600 })
}

const rawConfig = () => fs.readFileSync(getConfigPath(), 'utf-8')
const onDisk = () => parse(rawConfig()) as Record<string, unknown>

describe('clearDashboardPassword', () => {
  it('deletes dashboardPasswordHash from disk without touching other fields', () => {
    writeConfig()

    expect(clearDashboardPassword()).toEqual({ cleared: true, configPath: getConfigPath() })

    expect(onDisk()).toEqual(baseConfig())
  })

  // `canonry serve` holds the config it started with and passes that whole
  // object to `saveConfigPatch` on every write (a provider edit, an OAuth
  // token refresh). The password it still remembers must not go back on disk.
  it('is not undone when a running server saves its startup snapshot', () => {
    writeConfig()
    const startupSnapshot = loadConfig()
    expect(startupSnapshot.dashboardPasswordHash).toBe(PASSWORD_HASH)
    expect(clearDashboardPassword().cleared).toBe(true)

    saveConfigPatch({ ...startupSnapshot, lastSeenVersion: '9.9.9' })

    expect(onDisk()).toEqual({ ...baseConfig(), lastSeenVersion: '9.9.9' })
  })

  // Only a readable config.yaml can say "no password". When the file is gone
  // or broken, the same write must not drop the password the server runs with:
  // the rewritten file would reopen first-run setup at the next start.
  it.each([
    { name: 'missing', damage: () => fs.rmSync(getConfigPath()) },
    { name: 'empty', damage: () => fs.writeFileSync(getConfigPath(), '') },
    { name: 'malformed', damage: () => fs.writeFileSync(getConfigPath(), 'apiKey: [\n') },
  ])('keeps the password of a running server when config.yaml is $name', ({ damage }) => {
    writeConfig()
    const startupSnapshot = loadConfig()
    damage()

    saveConfigPatch(startupSnapshot)

    expect(onDisk()).toEqual({ ...baseConfig(), dashboardPasswordHash: PASSWORD_HASH })
  })

  // The server reads any falsy value as "no password".
  it.each([
    { name: 'no dashboardPasswordHash key', extra: {} },
    { name: 'a blank dashboardPasswordHash', extra: { dashboardPasswordHash: null } },
    { name: 'an empty dashboardPasswordHash', extra: { dashboardPasswordHash: '' } },
  ])('reports nothing to reset and leaves the file alone for $name', ({ extra }) => {
    writeConfig(extra)
    const before = rawConfig()

    expect(clearDashboardPassword()).toEqual({ cleared: false, configPath: getConfigPath() })

    expect(rawConfig()).toBe(before)
  })

  // A missing file usually means the server runs from another config
  // directory, so "nothing to reset" would report success on the wrong install.
  it('refuses a missing config file and names the path it looked at', () => {
    expect(() => clearDashboardPassword()).toThrow(expect.objectContaining({
      name: 'CliError',
      code: 'CONFIG_REQUIRED',
      exitCode: 1,
      message: expect.stringContaining(getConfigPath()),
    }))
    expect(fs.existsSync(getConfigPath())).toBe(false)
  })

  it.each([
    { name: 'malformed YAML', contents: 'apiKey: [cnry_secret_on_the_broken_line\n' },
    { name: 'a list at the top level', contents: '- apiKey: cnry_secret_on_the_broken_line\n' },
  ])('refuses $name without echoing the file or rewriting it', ({ contents }) => {
    fs.writeFileSync(getConfigPath(), contents, { mode: 0o600 })

    expect(() => clearDashboardPassword()).toThrow(expect.objectContaining({
      name: 'CliError',
      code: 'CONFIG_INVALID',
      exitCode: 1,
      message: expect.not.stringContaining('cnry_secret_on_the_broken_line'),
    }))
    expect(rawConfig()).toBe(contents)
  })
})

describe('canonry dashboard reset-password', () => {
  async function run(...flags: string[]): Promise<string> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await dispatchRegisteredCommand(['dashboard', 'reset-password', ...flags], 'text', DASHBOARD_CLI_COMMANDS)
      return log.mock.calls.map(call => String(call[0])).join('\n')
    } finally {
      log.mockRestore()
    }
  }

  function createNamedAccount() {
    const db = createClient(baseConfig().database)
    migrate(db)
    db.insert(users).values({
      id: 'user_sam', name: 'Sam', nameKey: 'sam', passwordHash: 'scrypt$1$fixture', role: 'admin',
      createdAt: new Date().toISOString(),
    }).run()
    db.$client.close()
  }

  it('clears the password and returns the JSON contract with the restart and setup steps', async () => {
    writeConfig()

    expect(JSON.parse(await run('--format', 'json'))).toEqual({
      reset: true,
      configPath: getConfigPath(),
      restartRequired: true,
      namedAccounts: false,
      nextSteps: [
        expect.stringMatching(/^Restart the server .*old password/),
        expect.stringMatching(/create the new password right away.*port forwarder/),
      ],
    })
    expect(onDisk()).toEqual(baseConfig())
  })

  it('prints the same steps for a person', async () => {
    writeConfig()

    const lines = (await run()).split('\n')

    expect(lines[0]).toBe(`Dashboard password cleared from ${getConfigPath()}.`)
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^Restart the server .*old password/),
      expect.stringMatching(/create the new password right away.*port forwarder/),
    ])
  })

  // Named accounts replace the shared password, so clearing it restores no
  // one's access and no setup screen follows.
  it('says a named-account install does not sign in with this password', async () => {
    writeConfig()
    createNamedAccount()

    expect(JSON.parse(await run('--format', 'json'))).toEqual({
      reset: true,
      configPath: getConfigPath(),
      restartRequired: false,
      namedAccounts: true,
      nextSteps: [
        expect.stringMatching(/named accounts.*does not change who can sign in/),
        expect.stringMatching(/canonry user list.*canonry user create/),
      ],
    })
    expect(onDisk()).toEqual(baseConfig())
  })

  it('reports nothing to reset when no password is set', async () => {
    writeConfig({})
    const before = rawConfig()

    expect(JSON.parse(await run('--format', 'json'))).toEqual({
      reset: false,
      configPath: getConfigPath(),
      restartRequired: false,
      namedAccounts: false,
      nextSteps: [expect.stringMatching(/still asks for a password.*restart the server/)],
    })
    expect(await run()).toMatch(new RegExp(`^No dashboard password is set in ${getConfigPath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}; nothing to reset\\.\\n`))
    expect(rawConfig()).toBe(before)
  })
})
