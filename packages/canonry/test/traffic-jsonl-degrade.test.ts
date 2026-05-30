import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'

// Mock the API client so the traffic command handlers run against canned DTOs
// and never touch the network. These are the traffic MUTATION commands
// (connect / sync / backfill / reset) — single-document responses, NOT
// jsonl-streaming collections. We assert the OUTPUT-FORMAT contract: `jsonl`
// degrades to the same JSON document `json` emits, while no-format output
// stays decorated human text.
//
// The collection commands (traffic events / sources / status) keep their
// `=== 'json'` envelope gate + `else if jsonl` streaming branch and are
// covered by traffic-jsonl.test.ts — deliberately not touched here.
const trafficConnectCloudRunMock = vi.fn()
const trafficSyncMock = vi.fn()
const trafficBackfillMock = vi.fn()
const trafficResetMock = vi.fn()
const getRunMock = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    trafficConnectCloudRun: trafficConnectCloudRunMock,
    trafficSync: trafficSyncMock,
    trafficBackfill: trafficBackfillMock,
    trafficReset: trafficResetMock,
    getRun: getRunMock,
  }),
}))

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return { logs, restore: () => { console.log = origLog } }
}

async function run(fn: () => Promise<void>): Promise<string> {
  const { logs, restore } = captureLog()
  try {
    await fn()
  } finally {
    restore()
  }
  return logs.join('\n')
}

const SOURCE_DTO = {
  id: 'src_123',
  sourceType: 'cloud-run',
  status: 'active',
  displayName: 'Prod logs',
  lastSyncedAt: null,
  lastError: null,
  config: {
    gcpProjectId: 'my-gcp-project',
    serviceName: 'web',
    location: 'us-central1',
  },
}

const SYNC_DTO = {
  runId: 'run_sync_1',
  windowStart: '2026-05-29T00:00:00.000Z',
  windowEnd: '2026-05-30T00:00:00.000Z',
  pulledEvents: 42,
  selfTrafficExcluded: 0,
  crawlerHits: 30,
  crawlerBucketRows: 3,
  aiReferralHits: 10,
  aiReferralBucketRows: 2,
  unknownHits: 2,
  sampleRows: 12,
  syncedAt: '2026-05-30T00:00:01.000Z',
}

const BACKFILL_DTO = {
  runId: 'run_backfill_1',
  windowStart: '2026-05-01T00:00:00.000Z',
  windowEnd: '2026-05-30T00:00:00.000Z',
  daysApplied: 29,
  daysRequested: 30,
  status: 'queued',
}

const RESET_DTO = {
  id: 'src_123',
  status: 'active',
  lastSyncedAt: '2026-05-30T00:00:00.000Z',
  lastError: null,
}

describe('traffic jsonl degrades to json for mutation commands', () => {
  beforeEach(() => {
    trafficConnectCloudRunMock.mockReset()
    trafficSyncMock.mockReset()
    trafficBackfillMock.mockReset()
    trafficResetMock.mockReset()
    getRunMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('trafficSync: --format jsonl emits the same JSON document as --format json', async () => {
    trafficSyncMock.mockResolvedValue(SYNC_DTO)
    const { trafficSync } = await import('../src/commands/traffic.js')

    const jsonOut = await run(() => trafficSync('p', { source: 'src_123', format: 'json' }))
    const jsonlOut = await run(() => trafficSync('p', { source: 'src_123', format: 'jsonl' }))
    const humanOut = await run(() => trafficSync('p', { source: 'src_123' }))

    const jsonParsed = JSON.parse(jsonOut)
    const jsonlParsed = JSON.parse(jsonlOut)
    expect(jsonlParsed).toEqual(jsonParsed)
    expect(jsonlOut).toBe(jsonOut)
    expect(jsonParsed.runId).toBe('run_sync_1')
    expect(jsonParsed.pulledEvents).toBe(42)

    expect(humanOut).toContain('Traffic sync complete for "p"')
    expect(() => JSON.parse(humanOut)).toThrow()
    expect(humanOut).not.toBe(jsonOut)
  })

  it('trafficConnectCloudRun: --format jsonl emits the same JSON document as --format json', async () => {
    trafficConnectCloudRunMock.mockResolvedValue(SOURCE_DTO)
    const { trafficConnectCloudRun } = await import('../src/commands/traffic.js')

    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const keyFile = path.join(os.tmpdir(), `traffic-key-${Date.now()}.json`)
    fs.writeFileSync(keyFile, JSON.stringify({ type: 'service_account' }))

    try {
      const opts = { gcpProject: 'my-gcp-project', serviceAccountKey: keyFile }
      const jsonOut = await run(() => trafficConnectCloudRun('p', { ...opts, format: 'json' }))
      const jsonlOut = await run(() => trafficConnectCloudRun('p', { ...opts, format: 'jsonl' }))
      const humanOut = await run(() => trafficConnectCloudRun('p', { ...opts }))

      const jsonParsed = JSON.parse(jsonOut)
      const jsonlParsed = JSON.parse(jsonlOut)
      expect(jsonlParsed).toEqual(jsonParsed)
      expect(jsonlOut).toBe(jsonOut)
      expect(jsonParsed.id).toBe('src_123')

      expect(humanOut).toContain('Cloud Run traffic source connected for project "p"')
      expect(() => JSON.parse(humanOut)).toThrow()
      expect(humanOut).not.toBe(jsonOut)
    } finally {
      fs.rmSync(keyFile, { force: true })
    }
  })

  it('trafficBackfill (no --wait): --format jsonl emits the same JSON document as --format json', async () => {
    trafficBackfillMock.mockResolvedValue(BACKFILL_DTO)
    const { trafficBackfill } = await import('../src/commands/traffic.js')

    const jsonOut = await run(() => trafficBackfill('p', { source: 'src_123', format: 'json' }))
    const jsonlOut = await run(() => trafficBackfill('p', { source: 'src_123', format: 'jsonl' }))
    const humanOut = await run(() => trafficBackfill('p', { source: 'src_123' }))

    const jsonParsed = JSON.parse(jsonOut)
    const jsonlParsed = JSON.parse(jsonlOut)
    expect(jsonlParsed).toEqual(jsonParsed)
    expect(jsonlOut).toBe(jsonOut)
    expect(jsonParsed.runId).toBe('run_backfill_1')
    expect(jsonParsed.daysApplied).toBe(29)

    expect(humanOut).toContain('Backfill submitted for "p"')
    expect(() => JSON.parse(humanOut)).toThrow()
    expect(humanOut).not.toBe(jsonOut)
  })

  it('trafficReset: --format jsonl emits the same JSON document as --format json', async () => {
    trafficResetMock.mockResolvedValue(RESET_DTO)
    const { trafficReset } = await import('../src/commands/traffic.js')

    const opts = { source: 'src_123', advanceToNow: true }
    const jsonOut = await run(() => trafficReset('p', { ...opts, format: 'json' }))
    const jsonlOut = await run(() => trafficReset('p', { ...opts, format: 'jsonl' }))
    const humanOut = await run(() => trafficReset('p', { ...opts }))

    const jsonParsed = JSON.parse(jsonOut)
    const jsonlParsed = JSON.parse(jsonlOut)
    expect(jsonlParsed).toEqual(jsonParsed)
    expect(jsonlOut).toBe(jsonOut)
    expect(jsonParsed.id).toBe('src_123')
    expect(jsonParsed.lastSyncedAt).toBe('2026-05-30T00:00:00.000Z')

    expect(humanOut).toContain('Traffic source reset for "p"')
    expect(() => JSON.parse(humanOut)).toThrow()
    expect(humanOut).not.toBe(jsonOut)
  })
})
