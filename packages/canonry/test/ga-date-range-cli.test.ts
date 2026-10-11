import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockGaAcquisition = vi.fn()
const mockGaTraffic = vi.fn()
const mockGaAiReferralHistory = vi.fn()
const mockGaAiReferralDaily = vi.fn()
const mockGaSocialReferralHistory = vi.fn()
const mockGaSessionHistory = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    gaTraffic: mockGaTraffic,
    gaAcquisition: mockGaAcquisition,
    gaAiReferralHistory: mockGaAiReferralHistory,
    gaAiReferralDaily: mockGaAiReferralDaily,
    gaSocialReferralHistory: mockGaSocialReferralHistory,
    gaSessionHistory: mockGaSessionHistory,
  }),
}))

const { GA_CLI_COMMANDS } = await import('../src/cli-commands/ga.js')
const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')

async function dispatch(argv: string[]): Promise<void> {
  await dispatchRegisteredCommand(argv, 'json', GA_CLI_COMMANDS)
}

describe('ga CLI --start / --end', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockGaAcquisition.mockReset().mockResolvedValue({ rows: [], window: { startDate: null, endDate: null } })
    mockGaTraffic.mockReset().mockResolvedValue({
      totalSessions: 0,
      totalOrganicSessions: 0,
      totalDirectSessions: 0,
      totalUsers: 0,
      topPages: [],
      aiReferrals: [],
      aiReferralLandingPages: [],
      socialReferrals: [],
    })
    mockGaAiReferralHistory.mockReset().mockResolvedValue([])
    mockGaAiReferralDaily.mockReset().mockResolvedValue({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
    mockGaSocialReferralHistory.mockReset().mockResolvedValue([])
    mockGaSessionHistory.mockReset().mockResolvedValue([])
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('forwards acquisition window and explicit dates together, with grouped CLI aliases', async () => {
    await dispatch(['ga', 'acquisition', 'example', '--window', '7d', '--start', '2026-09-01', '--end', '2026-09-30', '--channel', 'Organic Search', '--host', 'EXAMPLE.com', '--landing-page', '/pricing?plan=team', '--source', 'google', '--medium', 'organic', '--group-by', 'date,channel,host,landing-page', '--limit', '20', '--offset', '10'])
    expect(mockGaAcquisition).toHaveBeenCalledWith('example', expect.objectContaining({ window: '7d', startDate: '2026-09-01', endDate: '2026-09-30', channel: 'Organic Search', hostName: 'EXAMPLE.com', landingPage: '/pricing?plan=team', source: 'google', medium: 'organic', groupBy: 'date,channelGroup,hostName,landingPage', limit: 20, offset: 10 }))
  })

  it('leaves acquisition dates and window absent by default', async () => {
    await dispatch(['ga', 'acquisition', 'example'])
    const selection = mockGaAcquisition.mock.calls[0]![1]
    expect(selection.window).toBeUndefined()
    expect(selection.startDate).toBeUndefined()
    expect(selection.endDate).toBeUndefined()
  })

  it.each([['--group-by', 'unknown'], ['--limit', '1001'], ['--window', '60d'], ['--start', '2026-02-30']])('refuses invalid acquisition %s before calling the API', async (flag, value) => {
    await expect(dispatch(['ga', 'acquisition', 'example', flag, value])).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR', exitCode: 1 })
    expect(mockGaAcquisition).not.toHaveBeenCalled()
  })

  it('forwards a calendar month from ga session-history', async () => {
    await dispatch(['ga', 'session-history', 'acme', '--start', '2026-05-01', '--end', '2026-05-31'])
    expect(mockGaSessionHistory).toHaveBeenCalledWith('acme', { startDate: '2026-05-01', endDate: '2026-05-31' })
  })

  it('forwards a calendar month from ga traffic alongside limit', async () => {
    await dispatch(['ga', 'traffic', 'acme', '--start', '2026-05-01', '--end', '2026-05-31', '--limit', '10'])
    expect(mockGaTraffic).toHaveBeenCalledWith('acme', { limit: '10', startDate: '2026-05-01', endDate: '2026-05-31' })
  })

  it('forwards a calendar month from ga ai-referral-history', async () => {
    await dispatch(['ga', 'ai-referral-history', 'acme', '--start', '2026-05-01', '--end', '2026-05-31'])
    expect(mockGaAiReferralHistory).toHaveBeenCalledWith('acme', { startDate: '2026-05-01', endDate: '2026-05-31' })
  })

  it('forwards a calendar month from ga ai-referral-daily', async () => {
    await dispatch(['ga', 'ai-referral-daily', 'acme', '--start', '2026-05-01', '--end', '2026-05-31'])
    expect(mockGaAiReferralDaily).toHaveBeenCalledWith('acme', { startDate: '2026-05-01', endDate: '2026-05-31' })
  })

  it('forwards a calendar month from ga social-referral-history', async () => {
    await dispatch(['ga', 'social-referral-history', 'acme', '--start', '2026-05-01', '--end', '2026-05-31'])
    expect(mockGaSocialReferralHistory).toHaveBeenCalledWith('acme', { startDate: '2026-05-01', endDate: '2026-05-31' })
  })

  it('still forwards --window when no dates are supplied', async () => {
    await dispatch(['ga', 'session-history', 'acme', '--window', '30d'])
    expect(mockGaSessionHistory).toHaveBeenCalledWith('acme', { window: '30d' })
  })

  it('sends no query params when neither dates nor window are supplied', async () => {
    await dispatch(['ga', 'session-history', 'acme'])
    expect(mockGaSessionHistory).toHaveBeenCalledWith('acme', undefined)
  })

  it('forwards a lone --start as an open-ended lower bound', async () => {
    await dispatch(['ga', 'session-history', 'acme', '--start', '2026-05-01'])
    expect(mockGaSessionHistory).toHaveBeenCalledWith('acme', { startDate: '2026-05-01' })
  })
})
