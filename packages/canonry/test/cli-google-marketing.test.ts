import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { createGoogleMarketingCliCommands } from '../src/cli-commands/google-marketing.js'
import { REGISTERED_CLI_COMMANDS } from '../src/cli-commands.js'
import type { GoogleMarketingCliClient } from '../src/commands/google-marketing.js'

function captureStdout(fn: () => Promise<void>): Promise<string> {
  let output = ''
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    output += String(chunk)
    return true
  })
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output += `${args.map(String).join(' ')}\n`
  })
  return fn().finally(() => {
    writeSpy.mockRestore()
    logSpy.mockRestore()
  }).then(() => output)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Google Marketing CLI', () => {
  it('registers separate Google Ads, GTM, and conversion-contract namespaces', () => {
    const commandIds = REGISTERED_CLI_COMMANDS.map(command => command.path.join(' '))
    expect(commandIds).toEqual(expect.arrayContaining([
      'google-ads status',
      'google-ads customers',
      'google-ads sync',
      'google-ads performance',
      'gtm accounts',
      'gtm workspaces',
      'gtm sync',
      'conversion-tracking contracts integrity',
    ]))
    expect(commandIds).not.toContain('ads google-status')
    expect(commandIds).not.toContain('google-ads connect')
    expect(commandIds).not.toContain('gtm connect')
  })

  it('streams live Google Ads discovery as JSONL without mixing it into OpenAI ads', async () => {
    const client = {
      listGoogleAdsCustomers: vi.fn().mockResolvedValue({
        customers: [{ customerId: '123-456-7890', descriptiveName: 'Example Hotel', manager: false, status: 'enabled' }],
        totalAccessible: 1,
        truncated: false,
        fetchedAt: '2026-08-14T12:00:00.000Z',
      }),
    } as unknown as GoogleMarketingCliClient
    const commands = createGoogleMarketingCliCommands(() => client)

    const output = await captureStdout(async () => {
      await dispatchRegisteredCommand(['google-ads', 'customers', 'example', '--format', 'jsonl'], 'text', commands)
    })

    expect(client.listGoogleAdsCustomers).toHaveBeenCalledWith('example')
    expect(output.trim()).toBe(JSON.stringify({
      project: 'example',
      fetchedAt: '2026-08-14T12:00:00.000Z',
      customerId: '123-456-7890',
      descriptiveName: 'Example Hotel',
      manager: false,
      status: 'enabled',
    }))
  })

  it('normalizes returned GTM resource paths before container and workspace reads', async () => {
    const client = {
      listGtmContainers: vi.fn().mockResolvedValue({
        accountId: '1', containers: [], totalAccessible: 0, truncated: false,
        fetchedAt: '2026-08-14T12:00:00.000Z',
      }),
      listGtmWorkspaces: vi.fn().mockResolvedValue({
        accountId: '1', containerId: '2', workspaces: [], totalAccessible: 0, truncated: false,
        fetchedAt: '2026-08-14T12:00:00.000Z',
      }),
    } as unknown as GoogleMarketingCliClient
    const commands = createGoogleMarketingCliCommands(() => client)

    await captureStdout(async () => {
      await dispatchRegisteredCommand([
        'gtm', 'containers', 'example', '--account', 'accounts/1', '--format', 'json',
      ], 'text', commands)
      await dispatchRegisteredCommand([
        'gtm', 'workspaces', 'example', '--account', 'accounts/1',
        '--container', 'accounts/1/containers/2', '--format', 'json',
      ], 'text', commands)
    })

    expect(client.listGtmContainers).toHaveBeenCalledWith('example', '1')
    expect(client.listGtmWorkspaces).toHaveBeenCalledWith('example', '1', '2')
  })

  const performanceDto = {
    window: '7d',
    startDate: '2026-08-18',
    endDate: '2026-08-24',
    days: 7,
    totals: {
      impressions: 440,
      clicks: 20,
      costMicros: 6_000_000,
      conversions: 2.5,
      conversionValueMicros: 3_000_000,
      ctr: 20 / 440,
      cpcMicros: 300_000,
      conversionRate: 0.125,
      costPerConversionMicros: 2_400_000,
    },
    daily: [
      { date: '2026-08-18', origin: 'provider', impressions: 440, clicks: 20, costMicros: 6_000_000, conversions: 2.5, ctr: 20 / 440 },
      { date: '2026-08-19', origin: 'filled', impressions: 0, clicks: 0, costMicros: 0, conversions: 0, ctr: null },
    ],
    campaigns: [{
      campaignId: 'c1',
      name: 'Brand Search',
      status: 'enabled',
      totals: {
        impressions: 440, clicks: 20, costMicros: 6_000_000, conversions: 2.5,
        conversionValueMicros: 3_000_000, ctr: 20 / 440, cpcMicros: 300_000,
        conversionRate: 0.125, costPerConversionMicros: 2_400_000,
      },
    }],
    comparison: null,
    comparisonUnavailableReason: 'insufficient-history',
    source: {
      snapshotId: 'metrics-snapshot',
      capturedAt: '2026-08-25T12:00:00.000Z',
      customerId: '1234567890',
      currencyCode: 'USD',
      timeZone: 'UTC',
      asOfDate: '2026-08-24',
      openDate: '2026-08-25',
      truncated: false,
      campaignsQueried: 1,
      campaignsInInventory: 1,
    },
  }

  it('emits the performance DTO verbatim so a UI fetch can be swapped for the CLI', async () => {
    const client = {
      getGoogleAdsPerformance: vi.fn().mockResolvedValue(performanceDto),
    } as unknown as GoogleMarketingCliClient
    const commands = createGoogleMarketingCliCommands(() => client)

    const output = await captureStdout(async () => {
      await dispatchRegisteredCommand([
        'google-ads', 'performance', 'example', '--window', '7d', '--format', 'json',
      ], 'text', commands)
    })

    expect(client.getGoogleAdsPerformance).toHaveBeenCalledWith('example', { window: '7d' })
    // Byte-identical to the API response: no rounding, no currency formatting,
    // no micros division anywhere in the machine format.
    expect(JSON.parse(output)).toEqual(performanceDto)
  })

  it('formats micros as currency only in human output', async () => {
    const client = {
      getGoogleAdsPerformance: vi.fn().mockResolvedValue(performanceDto),
    } as unknown as GoogleMarketingCliClient
    const commands = createGoogleMarketingCliCommands(() => client)

    const output = await captureStdout(async () => {
      await dispatchRegisteredCommand(['google-ads', 'performance', 'example'], 'text', commands)
    })

    expect(client.getGoogleAdsPerformance).toHaveBeenCalledWith('example', {})
    expect(output).toContain('$6.00')
    expect(output).toContain('$0.30')
    expect(output).not.toContain('6000000')
    // The excluded partial day is named, so a reader does not read the newest
    // closed day as "today collapsed".
    expect(output).toContain('2026-08-25 still open, excluded')
    expect(output).toContain('unavailable (insufficient-history)')
  })

  it('prints CTR, conversion rate and the prior-period change through formatPercent', async () => {
    const withComparison = {
      ...performanceDto,
      comparison: {
        days: 7,
        prior: { startDate: '2026-08-11', endDate: '2026-08-17', days: 7, totals: performanceDto.totals },
        change: { impressions: 0.1, clicks: -0.0004, costMicros: 0, conversions: null, ctr: 0.1, conversionRate: null },
      },
      comparisonUnavailableReason: null,
    }
    const client = {
      getGoogleAdsPerformance: vi.fn().mockResolvedValue(withComparison),
    } as unknown as GoogleMarketingCliClient
    const commands = createGoogleMarketingCliCommands(() => client)

    const lines = (await captureStdout(async () => {
      await dispatchRegisteredCommand(['google-ads', 'performance', 'example'], 'text', commands)
    })).split('\n')

    // 20 / 440 is 4.545...%: one decimal, rounded half up on the tenth.
    expect(lines).toContain('Impressions:  440 (+10.0% vs prior period)')
    expect(lines).toContain('Clicks:       20 (CTR 4.5%) (-<0.1% vs prior period)')
    expect(lines).toContain('Cost:         $6.00 (CPC $0.30) (0% vs prior period)')
    expect(lines).toContain('Conversions:  2.5 (rate 12.5%, cost/conv $2.40)')
  })

  it('prints an undefined 0/0 ratio as a dash, never as 0%', async () => {
    const noDelivery = {
      ...performanceDto,
      totals: {
        ...performanceDto.totals,
        impressions: 0, clicks: 0, costMicros: 0, conversions: 0,
        ctr: null, cpcMicros: null, conversionRate: null, costPerConversionMicros: null,
      },
    }
    const client = {
      getGoogleAdsPerformance: vi.fn().mockResolvedValue(noDelivery),
    } as unknown as GoogleMarketingCliClient
    const commands = createGoogleMarketingCliCommands(() => client)

    const lines = (await captureStdout(async () => {
      await dispatchRegisteredCommand(['google-ads', 'performance', 'example'], 'text', commands)
    })).split('\n')

    expect(lines).toContain('Clicks:       0 (CTR —)')
    expect(lines).toContain('Conversions:  0 (rate —, cost/conv —)')
  })

  it('refuses a window the stored snapshot cannot serve', async () => {
    const client = { getGoogleAdsPerformance: vi.fn() } as unknown as GoogleMarketingCliClient
    const commands = createGoogleMarketingCliCommands(() => client)

    await expect(captureStdout(async () => {
      // 30d is servable now; 90d is the window the stored snapshot cannot reach.
      await dispatchRegisteredCommand(['google-ads', 'performance', 'example', '--window', '90d'], 'text', commands)
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(client.getGoogleAdsPerformance).not.toHaveBeenCalled()
  })

  it('keeps contract integrity agent-friendly as findings JSONL', async () => {
    const client = {
      getConversionTrackingIntegrity: vi.fn().mockResolvedValue({
        assessment: {
          contract: { id: 'contract_purchase' },
          status: 'runtime-unverified',
          evaluatedAt: '2026-08-14T12:00:00.000Z',
          findings: [{
            code: 'runtime-event-not-observed',
            subject: 'purchase',
            outcome: 'unknown',
            status: 'runtime-unverified',
            evidenceIds: [],
          }],
        },
      }),
    } as unknown as GoogleMarketingCliClient
    const commands = createGoogleMarketingCliCommands(() => client)

    const output = await captureStdout(async () => {
      await dispatchRegisteredCommand([
        'conversion-tracking', 'contracts', 'integrity', 'example', 'contract_purchase', '--format', 'jsonl',
      ], 'text', commands)
    })

    expect(client.getConversionTrackingIntegrity).toHaveBeenCalledWith('example', 'contract_purchase')
    expect(output.trim()).toBe(JSON.stringify({
      project: 'example',
      contractId: 'contract_purchase',
      integrityStatus: 'runtime-unverified',
      evaluatedAt: '2026-08-14T12:00:00.000Z',
      code: 'runtime-event-not-observed',
      subject: 'purchase',
      outcome: 'unknown',
      status: 'runtime-unverified',
      evidenceIds: [],
    }))
  })
})
