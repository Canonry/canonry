import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeCli } from './cli-test-utils.js'

const { createApiClient } = vi.hoisted(() => ({ createApiClient: vi.fn(() => { throw new Error('Unexpected API request before window validation') }) }))
vi.mock('../src/client.js', () => ({ createApiClient }))

const metrics = ['7d', '30d', '90d', 'all']
const selections: Array<[string[], string[]]> = [
  ...['acquisition', 'traffic', 'ai-referral-history', 'ai-referral-daily', 'social-referral-history', 'session-history'].map(name => [['ga', name], metrics] as [string[], string[]]),
  [['ga', 'measurement-analysis'], ['30d', '60d', '90d']],
  [['ga', 'search-landing-pages'], ['7d', '28d', '90d']],
  [['analytics'], metrics], [['sources'], metrics], [['competitor', 'landscape'], metrics],
  ...['performance', 'performance-daily', 'top-pages', 'query-totals'].map(name => [['google', name], metrics] as [string[], string[]]),
  [['google-ads', 'performance'], ['7d', '14d', '30d']],
  [['traffic', 'analytics'], ['7d', '14d', '30d', '90d']],
  [['organic-evidence'], ['60d', '90d']],
]

beforeEach(() => { createApiClient.mockClear(); vi.stubEnv('DO_NOT_TRACK', '1'); vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1') })
afterEach(() => { vi.unstubAllEnvs() })

describe('public window grammar', () => {
  it.each(selections)('%j reports its exact allowed windows before creating an API client', async (command, allowed) => {
    const result = await invokeCli([...command, 'synthetic-project', '--window', '29d', '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'CLI_USAGE_ERROR', message: `Invalid window "29d". Must be one of: ${allowed.join(', ')}.`, details: { field: 'window', value: '29d', allowed } } })
    expect(createApiClient).not.toHaveBeenCalled()
  })

  it.each([['traffic', 'analytics'], ['organic-evidence']])('%j refuses both a window and its period alias', async (...command) => {
    const result = await invokeCli([...command, 'synthetic-project', '--period', '90', '--window', '90d', '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(JSON.parse(result.stderr).error.message).toMatch(/--period.*--window|--window.*--period/)
    expect(createApiClient).not.toHaveBeenCalled()
  })

  it('prints all GA traffic windows in contextual help', async () => {
    const result = await invokeCli(['ga', 'traffic', '--help'])
    expect(result.stdout).toContain('[--window 7d|30d|90d|all]')
    expect(result.stdout).not.toContain('[--window 30d]')
    expect(createApiClient).not.toHaveBeenCalled()
  })
})

describe('calendar-date option validation before HTTP', () => {
  it.each([
    ['traffic', 'referral-assessment', 'example', '--start', '2026-09-01', '--start-date', '2026-09-01'],
    ['ads', 'insights', 'example', '--end', '2026-09-30', '--to', '2026-09-30'],
    ['ads', 'insights', 'example', '--start', '2026-02-30'],
    ['traffic', 'referral-assessment', 'example', '--start', '2026-09-30', '--end', '2026-09-01'],
  ])('rejects an ambiguous or invalid date selection %j', async (...args) => {
    const result = await invokeCli([...args, '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).error.code).toBe('CLI_USAGE_ERROR')
    expect(createApiClient).not.toHaveBeenCalled()
  })
})

it('shows canonical calendar flags and retained aliases in contextual help', async () => {
  const result = await invokeCli(['ads', 'insights', '--help'])
  expect(result.stdout).toContain('[--start YYYY-MM-DD] [--end YYYY-MM-DD]')
  expect(result.stdout).toContain('--from for --start; --to for --end')
  const traffic = await invokeCli(['traffic', 'analytics', '--help'])
  expect(traffic.stdout).toContain('[--window 7d|14d|30d|90d]')
  expect(traffic.stdout).toContain('--period for --window')
  expect(createApiClient).not.toHaveBeenCalled()
})

it.each([['ga', 'acquisition'], ['google', 'performance'], ['google', 'performance-daily'], ['google', 'top-pages'], ['google', 'query-totals']])('refuses a rolling window together with explicit dates for %j', async (...command) => {
  const result = await invokeCli([...command, 'example', '--window', '7d', '--start', '2026-09-01', '--end', '2026-09-30', '--format', 'json'])
  expect(result.exitCode).toBe(1)
  expect(JSON.parse(result.stderr).error.message).toMatch(/--window.*--start|--start.*--window/)
  expect(createApiClient).not.toHaveBeenCalled()
})

it.each(['json', 'jsonl'])('names invalid stored-read fields in %s errors', async format => {
  for (const [command, field] of [
    [['traffic', 'samples', 'example', '--kind', 'bogus'], 'kind'],
    [['traffic', 'samples', 'example', '--since', 'not-a-date'], 'since'],
    [['traffic', 'samples', 'example', '--limit', '501'], 'limit'],
    [['ga', 'acquisition', 'example', '--group-by', 'bogus'], 'groupBy'],
    [['ga', 'acquisition', 'example', '--offset=-1'], 'offset'],
    [['traffic', 'referral-assessment', 'example', '--start', '2026-09-01'], '--end'],
  ] as const) {
    const result = await invokeCli([...command, '--format', format])
    expect(result.exitCode).toBe(1)
    const error = JSON.parse(result.stderr).error
    expect(error.message).toContain(field)
    expect(error.message).not.toMatch(/^\[|\n/)
    expect(createApiClient).not.toHaveBeenCalled()
  }
})
