import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { GaSyncResponse } from '@ainyc/canonry-contracts'

const mockGaSync = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ gaSync: mockGaSync }),
}))

/**
 * Capture stdout and stderr separately — the whole point of the warning is
 * that it lands on stderr, leaving the `--format json` stdout contract
 * byte-for-byte parseable.
 */
function captureStreams(fn: () => Promise<void>) {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origError = console.error
  console.log = (...args: unknown[]) => out.push(args.join(' '))
  console.error = (...args: unknown[]) => err.push(args.join(' '))
  const run = fn().finally(() => {
    console.log = origLog
    console.error = origError
  })
  return { run, stdout: () => out.join('\n'), stderr: () => err.join('\n') }
}

const { gaSync } = await import('../src/commands/ga.js')

function syncResponse(overrides: Partial<GaSyncResponse> = {}): GaSyncResponse {
  return {
    synced: true,
    rowCount: 0,
    aiReferralCount: 0,
    socialReferralCount: 0,
    days: 90,
    requestedDays: 90,
    clamped: false,
    syncedAt: '2026-08-16T00:00:00.000Z',
    measurement: {
      acquisition: { days: 90, status: 'ready', rowCount: 0 },
      leads: { days: 0, status: 'not-configured', rowCount: 0 },
    },
    ...overrides,
  }
}

describe('canonry ga sync — clamped window reporting', () => {
  beforeEach(() => {
    mockGaSync.mockReset()
  })

  it('warns on stderr when the requested window was truncated', async () => {
    mockGaSync.mockResolvedValue(syncResponse({ days: 90, requestedDays: 500, clamped: true }))

    const cap = captureStreams(() => gaSync('acme-air', { days: 500 }))
    await cap.run

    // The operator asked for 500 and must be told they got 90.
    expect(cap.stderr()).toMatch(/requested 500 days but synced 90/)
    // And the human table reports the effective window, not the request.
    expect(cap.stdout()).toMatch(/Period:\s+90 days \(requested 500\)/)
    expect(cap.stdout()).not.toMatch(/Period:\s+500 days/)
  })

  it('stays silent on stderr when the window was honoured', async () => {
    mockGaSync.mockResolvedValue(syncResponse({ days: 30, requestedDays: 30, clamped: false }))

    const cap = captureStreams(() => gaSync('acme-air', { days: 30 }))
    await cap.run

    expect(cap.stderr()).toBe('')
    expect(cap.stdout()).toMatch(/Period:\s+30 days$/m)
    // No parenthetical when there is nothing to reconcile.
    expect(cap.stdout()).not.toMatch(/requested/)
  })

  it('warns in --format json without corrupting the stdout payload', async () => {
    mockGaSync.mockResolvedValue(syncResponse({ days: 90, requestedDays: 500, clamped: true }))

    const cap = captureStreams(() => gaSync('acme-air', { days: 500, format: 'json' }))
    await cap.run

    expect(cap.stderr()).toMatch(/requested 500 days but synced 90/)
    // stdout must still parse as exactly the response object.
    const parsed = JSON.parse(cap.stdout())
    expect(parsed.days).toBe(90)
    expect(parsed.requestedDays).toBe(500)
    expect(parsed.clamped).toBe(true)
  })

  it('forwards the raw --days request to the API rather than pre-clamping', async () => {
    // The server owns the bound; a CLI-side clamp would hide the truncation
    // from every other API consumer and make `requestedDays` a lie.
    mockGaSync.mockResolvedValue(syncResponse({ days: 90, requestedDays: 500, clamped: true }))

    const cap = captureStreams(() => gaSync('acme-air', { days: 500 }))
    await cap.run

    expect(mockGaSync).toHaveBeenCalledWith('acme-air', { days: 500 })
  })
})

describe('canonry ga sync: Search Console landing pages line', () => {
  beforeEach(() => {
    mockGaSync.mockReset()
  })

  it('prints a failed slice with its status, row count and error, and leaves it out of Components', async () => {
    mockGaSync.mockResolvedValue(syncResponse({
      measurement: {
        ...syncResponse().measurement,
        searchLandingPages: { status: 'error', windows: [], rowCount: 0, error: 'GA4 API error (500): backend error' },
      },
      syncedComponents: ['traffic', 'summary'],
    }))

    const cap = captureStreams(() => gaSync('acme-air', { only: 'search-landing' }))
    await cap.run

    const lines = cap.stdout().split('\n')
    expect(lines).toContain('  Components:  traffic, summary')
    expect(lines).toContain('  Search Console landing pages: error (0 rows)')
    expect(lines).toContain('    Error: GA4 API error (500): backend error')
    // The slice line sits inside the summary, before the sync time.
    expect(lines.indexOf('    Error: GA4 API error (500): backend error')).toBe(lines.findIndex(line => line.startsWith('  Synced at:')) - 1)
    expect(mockGaSync).toHaveBeenCalledWith('acme-air', { only: 'search-landing' })
  })

  it('prints a stored slice without an error line, and no line when the slice was not attempted', async () => {
    mockGaSync.mockResolvedValue(syncResponse({
      measurement: {
        ...syncResponse().measurement,
        searchLandingPages: {
          status: 'ready',
          windows: [
            { window: '7d', rowCount: 4, reportRowCount: 4, rowsCapped: false },
            { window: '28d', rowCount: 7, reportRowCount: 7, rowsCapped: false },
            { window: '90d', rowCount: 10, reportRowCount: 10, rowsCapped: false },
          ],
          rowCount: 21,
        },
      },
    }))

    const ready = captureStreams(() => gaSync('acme-air'))
    await ready.run

    expect(ready.stdout().split('\n')).toContain('  Search Console landing pages: ready (21 rows)')
    expect(ready.stdout()).not.toMatch(/Error:/)

    mockGaSync.mockResolvedValue(syncResponse({ syncedComponents: ['traffic', 'summary', 'social'] }))
    const other = captureStreams(() => gaSync('acme-air', { only: 'social' }))
    await other.run

    expect(other.stdout()).not.toMatch(/Search Console landing pages/)
  })
})
