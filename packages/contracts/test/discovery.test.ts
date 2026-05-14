import { test, expect } from 'vitest'
import {
  RunKinds,
  runKindSchema,
	  DiscoveryBuckets,
	  DEFAULT_DISCOVERY_PROMOTE_BUCKETS,
	  DISCOVERY_PROMOTE_COMPETITOR_CAP,
	  DISCOVERY_PROMOTE_COMPETITOR_MIN_HITS,
	  discoveryBucketSchema,
  DiscoverySessionStatuses,
  discoverySessionStatusSchema,
  DISCOVERY_MAX_PROBES_CAP,
  discoveryProbeDtoSchema,
  discoverySessionDtoSchema,
  discoverySessionDetailDtoSchema,
  discoveryCompetitorMapEntrySchema,
  discoveryRunRequestSchema,
  discoveryPromoteRequestSchema,
  discoveryPromoteResultSchema,
  queryProvenanceSchema,
} from '../src/index.js'

test('RunKinds includes the two discovery kinds', () => {
  expect(RunKinds['aeo-discover-seed']).toBe('aeo-discover-seed')
  expect(RunKinds['aeo-discover-probe']).toBe('aeo-discover-probe')
  expect(runKindSchema.parse('aeo-discover-seed')).toBe('aeo-discover-seed')
  expect(runKindSchema.parse('aeo-discover-probe')).toBe('aeo-discover-probe')
})

test('discoveryBucketSchema covers the three named buckets and rejects others', () => {
  expect(DiscoveryBuckets.cited).toBe('cited')
  expect(DiscoveryBuckets.aspirational).toBe('aspirational')
  expect(DiscoveryBuckets['wasted-surface']).toBe('wasted-surface')
  expect(() => discoveryBucketSchema.parse('unknown')).toThrow()
})

test('discovery promote defaults are production-safe', () => {
  expect(DEFAULT_DISCOVERY_PROMOTE_BUCKETS).toEqual([
    DiscoveryBuckets.cited,
    DiscoveryBuckets.aspirational,
  ])
  expect(DEFAULT_DISCOVERY_PROMOTE_BUCKETS).not.toContain(DiscoveryBuckets['wasted-surface'])
  expect(DISCOVERY_PROMOTE_COMPETITOR_MIN_HITS).toBe(2)
  expect(DISCOVERY_PROMOTE_COMPETITOR_CAP).toBe(20)
})

test('discoverySessionStatusSchema enumerates the lifecycle states', () => {
  for (const status of ['queued', 'seeding', 'probing', 'completed', 'failed'] as const) {
    expect(discoverySessionStatusSchema.parse(status)).toBe(status)
    expect(DiscoverySessionStatuses[status]).toBe(status)
  }
  expect(() => discoverySessionStatusSchema.parse('cancelled')).toThrow()
})

test('discoveryProbeDtoSchema parses a cited probe with cited domains', () => {
  const probe = discoveryProbeDtoSchema.parse({
    id: 'probe_1',
    sessionId: 'sess_1',
    projectId: 'proj_1',
    query: 'best boutique hotel williamsburg',
    citationState: 'cited',
    citedDomains: ['gjelinahotel.com', 'theyellowsign.com'],
    bucket: 'cited',
    createdAt: '2026-05-11T12:00:00.000Z',
  })
  expect(probe.citationState).toBe('cited')
  expect(probe.citedDomains).toEqual(['gjelinahotel.com', 'theyellowsign.com'])
  expect(probe.bucket).toBe('cited')
})

test('discoveryProbeDtoSchema defaults citedDomains to empty array when omitted', () => {
  const probe = discoveryProbeDtoSchema.parse({
    id: 'probe_2',
    sessionId: 'sess_1',
    projectId: 'proj_1',
    query: 'something nobody cites',
    citationState: 'not-cited',
    bucket: 'aspirational',
    createdAt: '2026-05-11T12:00:00.000Z',
  })
  expect(probe.citedDomains).toEqual([])
})

test('discoveryProbeDtoSchema allows null bucket (not yet classified)', () => {
  const probe = discoveryProbeDtoSchema.parse({
    id: 'probe_3',
    sessionId: 'sess_1',
    projectId: 'proj_1',
    query: 'pre-classification',
    citationState: 'cited',
    bucket: null,
    createdAt: '2026-05-11T12:00:00.000Z',
  })
  expect(probe.bucket).toBeNull()
})

test('discoverySessionDtoSchema parses an in-flight session with pre/post dedup counts', () => {
  const session = discoverySessionDtoSchema.parse({
    id: 'sess_1',
    projectId: 'proj_1',
    status: 'probing',
    icpDescription: 'Boutique destination hotel in Williamsburg',
    seedProvider: 'gemini',
    seedCountRaw: 142,
    seedCount: 48,
    dedupThreshold: 0.85,
    probeCount: 12,
    competitorMap: [{ domain: 'theyellowsign.com', hits: 4 }],
    createdAt: '2026-05-11T12:00:00.000Z',
  })
  expect(session.status).toBe('probing')
  expect(session.seedCountRaw).toBe(142)
  expect(session.seedCount).toBe(48)
  expect(session.dedupThreshold).toBeCloseTo(0.85)
  expect(session.competitorMap).toEqual([{ domain: 'theyellowsign.com', hits: 4 }])
})

test('discoverySessionDtoSchema defaults bucket counts to null when unset', () => {
  const session = discoverySessionDtoSchema.parse({
    id: 'sess_queued',
    projectId: 'proj_1',
    status: 'queued',
    competitorMap: [],
    createdAt: '2026-05-11T12:00:00.000Z',
  })
  expect(session.citedCount).toBeNull()
  expect(session.aspirationalCount).toBeNull()
  expect(session.wastedCount).toBeNull()
})

test('discoverySessionDetailDtoSchema embeds probes array', () => {
  const detail = discoverySessionDetailDtoSchema.parse({
    id: 'sess_1',
    projectId: 'proj_1',
    status: 'completed',
    competitorMap: [],
    createdAt: '2026-05-11T12:00:00.000Z',
    probes: [
      {
        id: 'probe_1',
        sessionId: 'sess_1',
        projectId: 'proj_1',
        query: 'q1',
        citationState: 'cited',
        bucket: 'cited',
        createdAt: '2026-05-11T12:00:01.000Z',
      },
    ],
  })
  expect(detail.probes).toHaveLength(1)
  expect(detail.probes[0].query).toBe('q1')
})

test('discoveryCompetitorMapEntrySchema requires positive hit count', () => {
  expect(discoveryCompetitorMapEntrySchema.parse({ domain: 'x.com', hits: 1 })).toEqual({
    domain: 'x.com',
    hits: 1,
  })
  expect(() => discoveryCompetitorMapEntrySchema.parse({ domain: 'x.com', hits: 0 })).toThrow()
  expect(() => discoveryCompetitorMapEntrySchema.parse({ domain: '', hits: 1 })).toThrow()
})

test('discoveryRunRequestSchema accepts ICP override + dedupThreshold + maxProbes', () => {
  const req = discoveryRunRequestSchema.parse({
    icpDescription: 'Boutique destination hotel in Williamsburg',
    dedupThreshold: 0.8,
    maxProbes: 60,
  })
  expect(req.icpDescription).toBe('Boutique destination hotel in Williamsburg')
  expect(req.dedupThreshold).toBeCloseTo(0.8)
  expect(req.maxProbes).toBe(60)
})

test('discoveryRunRequestSchema accepts empty object (use project defaults)', () => {
  const req = discoveryRunRequestSchema.parse({})
  expect(req.icpDescription).toBeUndefined()
  expect(req.dedupThreshold).toBeUndefined()
  expect(req.maxProbes).toBeUndefined()
})

test('discoveryRunRequestSchema rejects out-of-range dedupThreshold', () => {
  expect(() => discoveryRunRequestSchema.parse({ dedupThreshold: 1.5 })).toThrow()
  expect(() => discoveryRunRequestSchema.parse({ dedupThreshold: -0.1 })).toThrow()
})

test('discoveryRunRequestSchema caps maxProbes at DISCOVERY_MAX_PROBES_CAP', () => {
  expect(discoveryRunRequestSchema.parse({ maxProbes: DISCOVERY_MAX_PROBES_CAP }).maxProbes).toBe(
    DISCOVERY_MAX_PROBES_CAP,
  )
  expect(() =>
    discoveryRunRequestSchema.parse({ maxProbes: DISCOVERY_MAX_PROBES_CAP + 1 }),
  ).toThrow()
  expect(() => discoveryRunRequestSchema.parse({ maxProbes: 10_000 })).toThrow()
})

test('queryProvenanceSchema accepts "cli" and "discovery:<sessionId>" shapes', () => {
  expect(queryProvenanceSchema.parse('cli')).toBe('cli')
  expect(queryProvenanceSchema.parse('discovery:abc-123-def')).toBe('discovery:abc-123-def')
  expect(queryProvenanceSchema.parse('discovery:550e8400-e29b-41d4-a716-446655440000')).toBe(
    'discovery:550e8400-e29b-41d4-a716-446655440000',
  )
})

test('queryProvenanceSchema rejects other strings', () => {
  expect(() => queryProvenanceSchema.parse('manual')).toThrow()
  expect(() => queryProvenanceSchema.parse('discovery:')).toThrow()
  expect(() => queryProvenanceSchema.parse('')).toThrow()
})

test('discoveryPromoteRequestSchema accepts an empty object (server applies safe defaults)', () => {
  const req = discoveryPromoteRequestSchema.parse({})
  expect(req.buckets).toBeUndefined()
  expect(req.includeCompetitors).toBeUndefined()
})

test('discoveryPromoteRequestSchema accepts a bucket subset and includeCompetitors', () => {
  const req = discoveryPromoteRequestSchema.parse({
    buckets: ['cited', 'aspirational'],
    includeCompetitors: false,
  })
  expect(req.buckets).toEqual(['cited', 'aspirational'])
  expect(req.includeCompetitors).toBe(false)
})

test('discoveryPromoteRequestSchema rejects an empty buckets array and unknown bucket names', () => {
  expect(() => discoveryPromoteRequestSchema.parse({ buckets: [] })).toThrow()
  expect(() => discoveryPromoteRequestSchema.parse({ buckets: ['not-a-bucket'] })).toThrow()
})

test('discoveryPromoteResultSchema requires promoted + skipped query/competitor lists', () => {
  const result = discoveryPromoteResultSchema.parse({
    sessionId: 'sess-1',
    projectId: 'proj-1',
    promoted: { queries: ['q1', 'q2'], competitors: ['a.com'] },
    skipped: { queries: ['q3'], competitors: [] },
  })
  expect(result.promoted.queries).toEqual(['q1', 'q2'])
  expect(result.skipped.competitors).toEqual([])
  expect(() => discoveryPromoteResultSchema.parse({ sessionId: 'x', projectId: 'y' })).toThrow()
})
