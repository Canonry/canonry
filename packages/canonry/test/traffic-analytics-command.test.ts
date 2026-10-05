import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trafficAnalytics } from '../src/commands/traffic.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { TRAFFIC_CLI_COMMANDS } from '../src/cli-commands/traffic.js'
import { TRAFFIC_ANALYTICS_FIXTURE } from './traffic-analytics-fixture.js'

const { getTrafficAnalytics } = vi.hoisted(() => ({ getTrafficAnalytics: vi.fn() }))
vi.mock('../src/client.js', () => ({ createApiClient: () => ({ getTrafficAnalytics }) }))

beforeEach(() => {
  getTrafficAnalytics.mockReset().mockResolvedValue(TRAFFIC_ANALYTICS_FIXTURE)
})
afterEach(() => { vi.restoreAllMocks() })

describe('traffic analytics CLI', () => {
  it.each(['json', 'jsonl'])('preserves the complete API envelope in %s output, beyond the events detail cap', async format => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await trafficAnalytics('acme', { format })
    expect(getTrafficAnalytics).toHaveBeenCalledExactlyOnceWith('acme', 30)
    expect(output).toHaveBeenCalledOnce()
    const actual = JSON.parse(output.mock.calls[0]![0] as string)
    expect(actual).toEqual(TRAFFIC_ANALYTICS_FIXTURE)
    expect(actual.activity.topCrawledPaths).toHaveLength(501)
    expect(actual.activity.topCrawledPaths[500].path).toBe('/page-500')
  })

  it('dispatches the selected period and project through the registered command', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await dispatchRegisteredCommand(['traffic', 'analytics', 'advanced', '--period', '14', '--format', 'json'], 'text', TRAFFIC_CLI_COMMANDS)).toBe(true)
    expect(getTrafficAnalytics).toHaveBeenCalledExactlyOnceWith('advanced', 14)
  })

  it.each(['6', '0', 'abc', '30.5'])('rejects period %s as a user error before any request', async period => {
    await expect(trafficAnalytics('acme', { period, format: 'json' })).rejects.toMatchObject({ exitCode: 1 })
    expect(getTrafficAnalytics).not.toHaveBeenCalled()
  })

  it('preserves missing-source state in machine output', async () => {
    getTrafficAnalytics.mockResolvedValue({ activity: null })
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await trafficAnalytics('acme', { format: 'json' })
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ activity: null })
  })

  it('prints server counts and changes without reinterpreting their units', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await trafficAnalytics('acme', {})
    expect(output).toHaveBeenCalledWith('  Verified crawler hits: 501 (prior 400; change 25.3%)')
    expect(output).toHaveBeenCalledWith('  AI user-fetch hits: 9 (prior 0; change unavailable)')
    expect(output).toHaveBeenCalledWith('  AI-referral redirect hops: 3')
    expect(output).toHaveBeenCalledWith('  /page-500  1  0  1')
    expect(output).toHaveBeenCalledWith('  /page-500  17  1')
  })

  it('explains server-withheld deltas when prior recording is incomplete', async () => {
    getTrafficAnalytics.mockResolvedValue({ activity: { ...TRAFFIC_ANALYTICS_FIXTURE.activity,
      coverageStart: '2026-10-01T00:00:00.000Z', priorWindowComplete: false,
      verifiedCrawlerHits: { current: 200, prior: 84, deltaPct: null },
    } })
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await trafficAnalytics('acme', {})
    expect(output).toHaveBeenCalledWith('  First stored observation: 2026-10-01T00:00:00.000Z')
    expect(output).toHaveBeenCalledWith('  Prior recording window is incomplete; percentage changes are unavailable.')
    expect(output).toHaveBeenCalledWith('  Verified crawler hits: 200 (prior 84; change unavailable)')
  })
})
