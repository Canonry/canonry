import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  rawEventSamples,
  trafficSources,
} from '@canonry/canonry-db'
import type { NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { TrafficSourceStatuses, TrafficSourceTypes } from '@canonry/canonry-contracts'
import {
  enforceGlobalRawEventSampleRetention,
  enforceRawEventSampleRetention,
  rawEventSampleRetentionCutoff,
  retainedRawEventSampleTimestamp,
} from '../src/raw-event-sample-retention.js'
import { writeTrafficEventBatch } from '../src/traffic-event-ingest.js'

const REFERENCE_AT = '2026-08-17T12:00:00.000Z'
const CUTOFF = rawEventSampleRetentionCutoff(REFERENCE_AT)

function sampleRow(id: string, sourceId: string, ts: string) {
  return {
    id,
    projectId: 'project-retention',
    sourceId,
    ts,
    eventType: 'unknown',
    ipHash: null,
    userAgent: 'test-agent',
    pathNormalized: '/',
    status: 200,
    refererHost: null,
    classifierDetailsJson: {},
    createdAt: REFERENCE_AT,
  }
}

function event(eventId: string, observedAt: string): NormalizedTrafficRequest {
  return {
    sourceType: 'cloudflare',
    evidenceKind: 'raw-request',
    confidence: 'observed',
    eventId,
    observedAt,
    method: 'GET',
    requestUrl: 'https://example.com/',
    host: 'example.com',
    path: '/',
    queryString: null,
    status: 200,
    userAgent: 'test-agent',
    remoteIp: null,
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: 'cloudflare_zone', labels: {} },
    providerLabels: {},
  }
}

describe('raw event sample retention', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-sample-retention-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    db.insert(projects).values({
      id: 'project-retention',
      name: 'retention',
      displayName: 'Retention',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: REFERENCE_AT,
      updatedAt: REFERENCE_AT,
    }).run()
    for (const sourceId of ['source-under-test', 'other-source']) {
      db.insert(trafficSources).values({
        id: sourceId,
        projectId: 'project-retention',
        sourceType: TrafficSourceTypes.cloudflare,
        displayName: sourceId,
        status: TrafficSourceStatuses.connected,
        createdAt: REFERENCE_AT,
        updatedAt: REFERENCE_AT,
      }).run()
    }
  })

  afterEach(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('deletes only source-local samples before the cutoff and retains the exact boundary', () => {
    db.insert(rawEventSamples).values([
      sampleRow('expired', 'source-under-test', '2026-07-18T07:59:59.999-04:00'),
      sampleRow('boundary', 'source-under-test', '2026-07-18T08:00:00-04:00'),
      sampleRow('other-source-expired', 'other-source', '2026-07-18T07:59:59.999-04:00'),
    ]).run()

    expect(enforceRawEventSampleRetention(db, 'source-under-test', REFERENCE_AT)).toBe(CUTOFF)

    expect(db.select().from(rawEventSamples).all().map(row => row.id).sort()).toEqual([
      'boundary',
      'other-source-expired',
    ])
  })

  it('globally deletes expired samples from dormant sources', () => {
    db.insert(rawEventSamples).values([
      sampleRow('active-expired', 'source-under-test', '2026-07-18T07:59:59.999-04:00'),
      sampleRow('dormant-expired', 'other-source', '2026-07-18T07:59:59.999-04:00'),
      sampleRow('dormant-invalid', 'other-source', 'not-a-timestamp'),
      sampleRow('dormant-boundary', 'other-source', '2026-07-18T08:00:00-04:00'),
    ]).run()

    expect(enforceGlobalRawEventSampleRetention(db, REFERENCE_AT)).toBe(CUTOFF)
    expect(db.select().from(rawEventSamples).all().map(row => row.id))
      .toEqual(['dormant-boundary'])
  })

  it('canonicalizes offset timestamps before retention and storage', () => {
    expect(retainedRawEventSampleTimestamp('2026-07-18T08:00:00-04:00', CUTOFF))
      .toBe(CUTOFF)
    expect(retainedRawEventSampleTimestamp('2026-07-18T07:59:59.999-04:00', CUTOFF))
      .toBeNull()
  })

  it('does not persist an incoming sample before the cutoff', () => {
    const result = writeTrafficEventBatch({
      db,
      projectId: 'project-retention',
      sourceId: 'source-under-test',
      events: [
        event('expired-event', '2026-07-18T07:59:59.999-04:00'),
        event('boundary-event', '2026-07-18T08:00:00-04:00'),
      ],
      receivedAt: REFERENCE_AT,
      receiptTtlMs: 60_000,
      sampleLimit: 100,
      validateSource: source => expect(source?.id).toBe('source-under-test'),
      sourceUpdate: { lastSyncedAt: REFERENCE_AT, updatedAt: REFERENCE_AT },
    })

    expect(result.acceptedEvents).toBe(2)
    expect(result.sampleRows).toBe(1)
    expect(
      db.select().from(rawEventSamples)
        .where(eq(rawEventSamples.sourceId, 'source-under-test'))
        .all()
        .map(row => row.ts),
    ).toEqual([CUTOFF])
  })
})
