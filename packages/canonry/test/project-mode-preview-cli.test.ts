import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invokeCli } from './cli-test-utils.js'

const client = vi.hoisted(() => ({ getProject: vi.fn(), previewCompetitorAutoAliases: vi.fn(), patchProject: vi.fn(), putProject: vi.fn() }))
vi.mock('../src/client.js', () => ({ createApiClient: () => client }))
vi.mock('../src/skills-autosync.js', () => ({ autoSyncSkills: async () => null, formatAutoSyncNotice: () => null }))
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('DO_NOT_TRACK', '1')
  vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
  client.getProject.mockResolvedValue({ name: 'demo', configRevision: 1, competitorAutoAliases: 'preview' })
  client.previewCompetitorAutoAliases.mockResolvedValue({ impact: {
    before: { percent: 40 }, after: { percent: 100 / 3 }, queryClass: 'non-brand',
    runIds: ['sweep'], restatesHistory: true,
  } })
})
afterEach(() => vi.unstubAllEnvs())

it.each([
  ['--site-audit-max-pages', 'full'],
  ['--negative-review-max-stars', 'default'],
  ['--all-providers'],
].map(flags => [flags]))('refuses a mode preview with another explicit change %j', async flags => {
  const result = await invokeCli(['project', 'update', 'demo', '--competitor-auto-aliases', 'apply', '--dry-run', ...flags, '--format', 'json'])
  expect(result.exitCode).toBe(1)
  expect(JSON.parse(result.stderr).error.code).toBe('CLI_USAGE_ERROR')
  expect(client.previewCompetitorAutoAliases).not.toHaveBeenCalled()
  expect(client.patchProject).not.toHaveBeenCalled()
  expect(client.putProject).not.toHaveBeenCalled()
})

it.each(['preview', 'off'])('does not present applied names as the impact of mode %s', async mode => {
  const result = await invokeCli(['project', 'update', 'demo', '--competitor-auto-aliases', mode, '--dry-run', '--format', 'json'])
  expect(result.exitCode).toBe(1)
  expect(client.previewCompetitorAutoAliases).not.toHaveBeenCalled()
})

it('prints a formatted impact for an apply-mode preview and never writes', async () => {
  const result = await invokeCli(['project', 'update', 'demo', '--competitor-auto-aliases', 'apply', '--dry-run'])
  expect(result.exitCode, result.stderr).toBeUndefined()
  expect(result.stdout).toContain('preview -> apply')
  expect(result.stdout).toContain('40.0% -> 33.3%')
  expect(client.previewCompetitorAutoAliases).toHaveBeenCalledExactlyOnceWith('demo')
  expect(client.patchProject).not.toHaveBeenCalled()
  expect(client.putProject).not.toHaveBeenCalled()
})
