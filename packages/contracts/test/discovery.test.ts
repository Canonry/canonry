import { test, expect } from 'vitest'
import {
  RunKinds,
  runKindSchema,
	  DiscoveryBuckets,
	  DEFAULT_DISCOVERY_PROMOTE_BUCKETS,
	  DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES,
	  DISCOVERY_PROMOTE_COMPETITOR_CAP,
	  DISCOVERY_PROMOTE_COMPETITOR_MIN_HITS,
	  discoveryBucketSchema,
	  DiscoveryCompetitorTypes,
	  discoveryCompetitorTypeSchema,
  DiscoverySessionStatuses,
  discoverySessionStatusSchema,
  DISCOVERY_MAX_PROBES_CAP,
  DISCOVERY_DEFAULT_DEDUP_THRESHOLD,
  DISCOVERY_SEED_COLLAPSE_MIN_RAW,
  DISCOVERY_SEED_COLLAPSE_RATIO,
  seedCollapseWarning,
  discoveryProbeDtoSchema,
  discoverySessionDtoSchema,
  discoverySessionDetailDtoSchema,
  discoveryCompetitorMapEntrySchema,
  discoveryRunRequestSchema,
  discoveryPromoteRequestSchema,
  discoveryPromoteResultSchema,
  queryProvenanceSchema,
  aggregateHarvestedQueries,
  gateHarvestedSearchQueries,
  applyHarvestSemanticNovelty,
  buildHarvestAnchorTerms,
  isNavigationalHarvestQuery,
  discoveryHarvestDtoSchema,
  DISCOVERY_HARVEST_NOVELTY_THRESHOLD,
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

test('discoveryCompetitorTypeSchema enumerates the classification categories', () => {
  for (const type of ['direct-competitor', 'ota-aggregator', 'editorial-media', 'other', 'unknown'] as const) {
    expect(discoveryCompetitorTypeSchema.parse(type)).toBe(type)
    expect(DiscoveryCompetitorTypes[type]).toBe(type)
  }
  expect(() => discoveryCompetitorTypeSchema.parse('partner')).toThrow()
})

test('default promote competitor types is direct-competitor only', () => {
  expect(DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES).toEqual([
    DiscoveryCompetitorTypes['direct-competitor'],
  ])
  // Aggregators, editorial media, `other`, and legacy `unknown` are excluded
  // from the default promote — they require an explicit competitorTypes opt-in.
  expect(DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES).not.toContain(DiscoveryCompetitorTypes['ota-aggregator'])
  expect(DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES).not.toContain(DiscoveryCompetitorTypes['editorial-media'])
  expect(DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES).not.toContain(DiscoveryCompetitorTypes.other)
  expect(DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES).not.toContain(DiscoveryCompetitorTypes.unknown)
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

test('discoveryProbeDtoSchema parses the answer-text mention signal (true and false)', () => {
  const mentioned = discoveryProbeDtoSchema.parse({
    id: 'probe_m', sessionId: 'sess_1', projectId: 'proj_1', query: 'q',
    citationState: 'not-cited', answerMentioned: true, createdAt: '2026-05-11T12:00:00.000Z',
  })
  expect(mentioned.answerMentioned).toBe(true)
  // cited as a source but NOT named in the answer text: the two signals are independent.
  const citedNotMentioned = discoveryProbeDtoSchema.parse({
    id: 'probe_c', sessionId: 'sess_1', projectId: 'proj_1', query: 'q',
    citationState: 'cited', citedDomains: ['client.com'], answerMentioned: false, createdAt: '2026-05-11T12:00:00.000Z',
  })
  expect(citedNotMentioned.citationState).toBe('cited')
  expect(citedNotMentioned.answerMentioned).toBe(false)
})

test('discoveryProbeDtoSchema defaults citedDomains to empty array and answerMentioned to null when omitted', () => {
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
  // legacy probe with no mention signal: unknown, not false
  expect(probe.answerMentioned).toBeNull()
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
    competitorMap: [{ domain: 'theyellowsign.com', hits: 4, competitorType: 'direct-competitor' }],
    createdAt: '2026-05-11T12:00:00.000Z',
  })
  expect(session.status).toBe('probing')
  expect(session.seedCountRaw).toBe(142)
  expect(session.seedCount).toBe(48)
  expect(session.dedupThreshold).toBeCloseTo(0.85)
  expect(session.competitorMap).toEqual([
    { domain: 'theyellowsign.com', hits: 4, competitorType: 'direct-competitor' },
  ])
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
    competitorType: 'unknown',
  })
  expect(() => discoveryCompetitorMapEntrySchema.parse({ domain: 'x.com', hits: 0 })).toThrow()
  expect(() => discoveryCompetitorMapEntrySchema.parse({ domain: '', hits: 1 })).toThrow()
})

test('discoveryCompetitorMapEntrySchema defaults competitorType to unknown and accepts explicit types', () => {
  // Legacy entries persisted before classification existed have no
  // competitorType — they must still parse, defaulting to unknown.
  expect(discoveryCompetitorMapEntrySchema.parse({ domain: 'legacy.com', hits: 3 }).competitorType).toBe(
    'unknown',
  )
  expect(
    discoveryCompetitorMapEntrySchema.parse({
      domain: 'rival.com',
      hits: 5,
      competitorType: 'direct-competitor',
    }),
  ).toEqual({ domain: 'rival.com', hits: 5, competitorType: 'direct-competitor' })
  expect(() =>
    discoveryCompetitorMapEntrySchema.parse({ domain: 'x.com', hits: 1, competitorType: 'rival' }),
  ).toThrow()
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
  expect(req.locations).toBeUndefined()
})

test('discoveryRunRequestSchema accepts a locations label override', () => {
  const req = discoveryRunRequestSchema.parse({ locations: ['michigan', 'florida'] })
  expect(req.locations).toEqual(['michigan', 'florida'])
})

test('discoveryRunRequestSchema rejects empty-string location labels', () => {
  expect(() => discoveryRunRequestSchema.parse({ locations: [''] })).toThrow()
  expect(() => discoveryRunRequestSchema.parse({ locations: ['michigan', ''] })).toThrow()
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
  expect(req.competitorTypes).toBeUndefined()
})

test('discoveryPromoteRequestSchema accepts a bucket subset, includeCompetitors, and competitorTypes', () => {
  const req = discoveryPromoteRequestSchema.parse({
    buckets: ['cited', 'aspirational'],
    includeCompetitors: false,
    competitorTypes: ['direct-competitor', 'editorial-media'],
  })
  expect(req.buckets).toEqual(['cited', 'aspirational'])
  expect(req.includeCompetitors).toBe(false)
  expect(req.competitorTypes).toEqual(['direct-competitor', 'editorial-media'])
})

test('discoveryPromoteRequestSchema rejects empty / unknown buckets and competitorTypes', () => {
  expect(() => discoveryPromoteRequestSchema.parse({ buckets: [] })).toThrow()
  expect(() => discoveryPromoteRequestSchema.parse({ buckets: ['not-a-bucket'] })).toThrow()
  expect(() => discoveryPromoteRequestSchema.parse({ competitorTypes: [] })).toThrow()
  expect(() => discoveryPromoteRequestSchema.parse({ competitorTypes: ['not-a-type'] })).toThrow()
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

test('seedCollapseWarning fires on a degenerate collapse with exact counts in the message', () => {
  const warning = seedCollapseWarning({ seedCountRaw: 30, canonicalCount: 1, dedupThreshold: 0.85 })
  expect(warning).toBe(
    'Seed dedup collapsed 30 raw candidates into 1 canonical query at threshold 0.85. ' +
      'Distinct intents were likely merged into one cluster; re-run with a higher --dedup-threshold.',
  )
})

test('seedCollapseWarning pluralizes the canonical count', () => {
  const warning = seedCollapseWarning({ seedCountRaw: 30, canonicalCount: 5, dedupThreshold: 0.85 })
  expect(warning).toContain('into 5 canonical queries')
})

test('seedCollapseWarning ratio boundary: strictly below the floor warns, at the floor does not', () => {
  expect(DISCOVERY_SEED_COLLAPSE_RATIO).toBe(0.2)
  // 1/10 = 0.1 < 0.2 — warns
  expect(seedCollapseWarning({ seedCountRaw: 10, canonicalCount: 1, dedupThreshold: 0.95 })).not.toBeNull()
  // 2/10 = 0.2, not strictly below the floor — healthy
  expect(seedCollapseWarning({ seedCountRaw: 10, canonicalCount: 2, dedupThreshold: 0.95 })).toBeNull()
})

test('seedCollapseWarning ignores seed sets below the minimum raw count', () => {
  expect(DISCOVERY_SEED_COLLAPSE_MIN_RAW).toBe(10)
  // 1/9 is well under the ratio, but the set is too small to judge.
  expect(seedCollapseWarning({ seedCountRaw: 9, canonicalCount: 1, dedupThreshold: 0.95 })).toBeNull()
  expect(seedCollapseWarning({ seedCountRaw: 0, canonicalCount: 0, dedupThreshold: 0.95 })).toBeNull()
})

test('seedCollapseWarning stays quiet on a healthy dedup', () => {
  expect(seedCollapseWarning({ seedCountRaw: 30, canonicalCount: 25, dedupThreshold: 0.95 })).toBeNull()
  expect(
    seedCollapseWarning({
      seedCountRaw: 30,
      canonicalCount: 30,
      dedupThreshold: DISCOVERY_DEFAULT_DEDUP_THRESHOLD,
    }),
  ).toBeNull()
})

test('discoverySessionDtoSchema carries the optional warning field', () => {
  const session = discoverySessionDtoSchema.parse({
    id: 'sess_warn',
    projectId: 'proj_1',
    status: 'completed',
    competitorMap: [],
    warning: 'Seed dedup collapsed 30 raw candidates into 1 canonical query at threshold 0.85.',
    createdAt: '2026-06-11T12:00:00.000Z',
  })
  expect(session.warning).toContain('Seed dedup collapsed')
  // Legacy rows without the column still parse.
  const legacy = discoverySessionDtoSchema.parse({
    id: 'sess_legacy',
    projectId: 'proj_1',
    status: 'completed',
    competitorMap: [],
    createdAt: '2026-06-11T12:00:00.000Z',
  })
  expect(legacy.warning).toBeUndefined()
})

// ─── Probe fan-out harvest gate (issue #713) ─────────────────────────────────

test('aggregateHarvestedQueries counts distinct probes, deduping within a probe', () => {
  const candidates = aggregateHarvestedQueries([
    { searchQueries: ['solar panel cost', 'Solar Panel Cost', 'best solar installer'] },
    { searchQueries: ['solar panel cost', 'solar battery storage'] },
    { searchQueries: [] },
  ])
  const byQuery = Object.fromEntries(candidates.map(c => [c.query, c.probeHits]))
  // Same query twice in one probe → 1 hit; across two probes → 2 hits.
  expect(byQuery['solar panel cost']).toBe(2)
  expect(byQuery['best solar installer']).toBe(1)
  expect(byQuery['solar battery storage']).toBe(1)
  // Normalization collapses case so "Solar Panel Cost" is not a separate key.
  expect(Object.keys(byQuery).sort()).toEqual([
    'best solar installer',
    'solar battery storage',
    'solar panel cost',
  ])
})

test('gateHarvestedSearchQueries admits clean buyer-intent and rejects each noise class once', () => {
  const result = gateHarvestedSearchQueries({
    candidates: [
      { query: 'best solar installer austin', probeHits: 3 }, // admit
      { query: 'solar panel cost', probeHits: 1 },            // admit
      { query: 'acme solar phone number', probeHits: 4 },     // navigational (marker)
      { query: 'acme solar 5125550143', probeHits: 2 },       // navigational (contiguous digit run)
      { query: 'solar', probeHits: 1 },                       // length: < MIN_CHARS? no — 5 chars; but single token, anchored ok → admit
      { query: 'best solar installer for a three bedroom home with a south facing roof in austin texas today', probeHits: 1 }, // length: too many words
    ],
    trackedQueries: ['solar panel installation cost'],
    anchorTerms: buildHarvestAnchorTerms(['solar energy installers', 'rooftop solar panels']),
  })
  const admitted = result.admitted.map(c => c.query)
  expect(admitted).toContain('best solar installer austin')
  expect(admitted).toContain('solar panel cost')
  expect(admitted).toContain('solar')
  expect(result.stats.rejected.navigational).toBe(2)
  expect(result.stats.rejected.length).toBe(1)
  // Exact bookkeeping: admitted + every rejection class == raw candidates.
  const r = result.stats.rejected
  expect(result.stats.rawCandidates).toBe(6)
  expect(
    result.stats.admitted +
      r.belowFloor + r.length + r.navigational + r.duplicate + r.offAnchor + r.semanticDuplicate,
  ).toBe(result.stats.rawCandidates)
  // The lexical gate never sets semanticDuplicate — that's the embedding pass.
  expect(r.semanticDuplicate).toBe(0)
  // Sorted by recurrence desc.
  expect(result.admitted[0]).toEqual({ query: 'best solar installer austin', probeHits: 3 })
})

test('gateHarvestedSearchQueries drops only EXACT tracked matches (near-dups go to the semantic pass)', () => {
  const result = gateHarvestedSearchQueries({
    candidates: [
      { query: 'Solar Panel Cost', probeHits: 5 },            // exact (case-insensitive) dup → dropped here
      { query: 'solar panel pricing', probeHits: 3 },         // synonym of tracked → NOT lexical; survives for semantic pass
      { query: 'commercial solar tax credit', probeHits: 2 }, // novel → admit
    ],
    trackedQueries: ['solar panel cost'],
    applyAnchor: false,
  })
  // Only the exact match is dropped lexically; the synonym survives the lexical
  // gate (the embedding pass is what catches it).
  expect(result.admitted.map(c => c.query).sort()).toEqual([
    'commercial solar tax credit',
    'solar panel pricing',
  ])
  expect(result.stats.rejected.duplicate).toBe(1)
  expect(result.stats.rejected.semanticDuplicate).toBe(0)
})

test('applyHarvestSemanticNovelty drops candidates within the cosine threshold of a tracked query', () => {
  // Hand-built vectors: "price" and "cost" embed to the SAME intent vector (a
  // synonym pair an exact-match gate is blind to); "battery" is orthogonal.
  const COST = [1, 0, 0]
  const BATTERY = [0, 0, 1]
  const lexical = gateHarvestedSearchQueries({
    candidates: [
      { query: 'solar panel pricing', probeHits: 3 }, // synonym of tracked cost
      { query: 'solar battery storage', probeHits: 1 }, // novel
    ],
    trackedQueries: ['solar panel cost'],
    applyAnchor: false,
  })
  expect(lexical.admitted.map(c => c.query)).toEqual(['solar panel pricing', 'solar battery storage'])

  const result = applyHarvestSemanticNovelty({
    result: lexical,
    // aligned 1:1 with lexical.admitted
    candidateVectors: [COST, BATTERY],
    trackedVectors: [COST], // the tracked "solar panel cost"
  })
  expect(result.admitted.map(c => c.query)).toEqual(['solar battery storage'])
  expect(result.stats.rejected.semanticDuplicate).toBe(1)
  // Invariant still holds across both stages.
  const r = result.stats.rejected
  expect(
    result.stats.admitted +
      r.belowFloor + r.length + r.navigational + r.duplicate + r.offAnchor + r.semanticDuplicate,
  ).toBe(result.stats.rawCandidates)
})

test('applyHarvestSemanticNovelty uses the discovery-calibrated threshold and respects the gap', () => {
  // The novelty threshold is the discovery dedup threshold (0.95). A candidate
  // at cosine ~0.92 (distinct-but-adjacent intent) is kept, not dropped.
  expect(DISCOVERY_HARVEST_NOVELTY_THRESHOLD).toBe(0.95)
  const lexical = gateHarvestedSearchQueries({
    candidates: [{ query: 'solar adjacent intent', probeHits: 1 }],
    trackedQueries: ['solar panel cost'],
    applyAnchor: false,
  })
  // Vectors ~0.93 cosine apart (below 0.95) → kept.
  const result = applyHarvestSemanticNovelty({
    result: lexical,
    candidateVectors: [[1, 0.38, 0]],
    trackedVectors: [[1, 0, 0]],
  })
  expect(result.admitted.map(c => c.query)).toEqual(['solar adjacent intent'])
  expect(result.stats.rejected.semanticDuplicate).toBe(0)
})

test('applyHarvestSemanticNovelty fails open on a vector/candidate length mismatch or empty tracked set', () => {
  const lexical = gateHarvestedSearchQueries({
    candidates: [{ query: 'solar panel pricing', probeHits: 1 }],
    trackedQueries: ['solar panel cost'],
    applyAnchor: false,
  })
  // Misaligned candidate vectors → return unchanged (never mis-drop).
  const misaligned = applyHarvestSemanticNovelty({
    result: lexical,
    candidateVectors: [], // length 0 ≠ admitted length 1
    trackedVectors: [[1, 0, 0]],
  })
  expect(misaligned.admitted.map(c => c.query)).toEqual(['solar panel pricing'])
  expect(misaligned.stats.rejected.semanticDuplicate).toBe(0)
  // No tracked vectors → nothing to dedup against → unchanged.
  const noTracked = applyHarvestSemanticNovelty({
    result: lexical,
    candidateVectors: [[1, 0, 0]],
    trackedVectors: [],
  })
  expect(noTracked.admitted.map(c => c.query)).toEqual(['solar panel pricing'])
})

test('gateHarvestedSearchQueries anchor drops off-subject acronym collisions but keeps related subjects', () => {
  // Project subject is solar; a brand acronym ("cbp") collided with a customs
  // program in the fan-out. The anchor is built from the SUBJECT, not the name.
  const result = gateHarvestedSearchQueries({
    candidates: [
      { query: 'cbp trusted traveler global entry', probeHits: 4 }, // off-anchor (customs)
      { query: 'solar battery storage rebate', probeHits: 1 },      // on-anchor (related)
    ],
    trackedQueries: [],
    anchorTerms: buildHarvestAnchorTerms(['residential solar panel installers']),
  })
  expect(result.admitted.map(c => c.query)).toEqual(['solar battery storage rebate'])
  expect(result.stats.rejected.offAnchor).toBe(1)
  expect(result.anchorApplied).toBe(true)
})

test('gateHarvestedSearchQueries skips the anchor when the subject corpus is too sparse', () => {
  // A thin project: only one significant subject term → anchor cannot run, so
  // it must not silently drop everything. anchorApplied is false.
  const result = gateHarvestedSearchQueries({
    candidates: [
      { query: 'global entry interview wait', probeHits: 2 },
      { query: 'tsa precheck renewal', probeHits: 1 },
    ],
    trackedQueries: [],
    anchorTerms: buildHarvestAnchorTerms(['solar']), // < MIN_ANCHOR_TERMS significant terms
  })
  expect(result.anchorApplied).toBe(false)
  expect(result.stats.rejected.offAnchor).toBe(0)
  expect(result.admitted).toHaveLength(2)
})

test('gateHarvestedSearchQueries honors the recurrence floor (minProbeHits)', () => {
  const result = gateHarvestedSearchQueries({
    candidates: [
      { query: 'solar panel cost', probeHits: 1 },
      { query: 'solar installer reviews', probeHits: 3 },
    ],
    trackedQueries: [],
    applyAnchor: false,
    minProbeHits: 2,
  })
  expect(result.admitted.map(c => c.query)).toEqual(['solar installer reviews'])
  expect(result.stats.rejected.belowFloor).toBe(1)
})

test('discoveryHarvestDtoSchema round-trips a harvest payload', () => {
  const dto = discoveryHarvestDtoSchema.parse({
    sessionId: 'sess_1',
    projectId: 'proj_1',
    provider: 'gemini',
    status: 'completed',
    minProbeHits: 1,
    anchorApplied: true,
    semanticNoveltyApplied: true,
    candidates: [{ query: 'solar panel cost', probeHits: 2 }],
    stats: {
      rawCandidates: 4,
      admitted: 1,
      rejected: { belowFloor: 0, length: 1, navigational: 1, duplicate: 0, offAnchor: 0, semanticDuplicate: 1 },
    },
  })
  expect(dto.candidates[0].probeHits).toBe(2)
  expect(dto.provider).toBe('gemini')
  expect(dto.semanticNoveltyApplied).toBe(true)
  expect(dto.stats.rejected.semanticDuplicate).toBe(1)
})

test('isNavigationalHarvestQuery flags phone/address lookups but not local buyer intent', () => {
  expect(isNavigationalHarvestQuery('acme solar phone number')).toBe(true)
  expect(isNavigationalHarvestQuery('acme solar address')).toBe(true)
  // An unformatted phone string trips the contiguous-digit-run check.
  expect(isNavigationalHarvestQuery('call acme solar 5125550143')).toBe(true)
  // Queries that merely MENTION several short numbers (years, model numbers)
  // must NOT be flagged — the check is contiguous run length, not total digits.
  expect(isNavigationalHarvestQuery('best solar panels 2024 2025')).toBe(false)
  expect(isNavigationalHarvestQuery('iphone 15 pro release 2024 2025')).toBe(false)
  expect(isNavigationalHarvestQuery('top 100 solar stocks 2023 2024 2025')).toBe(false)
  // "near me" / "reviews" are real local buyer intent — not navigational.
  expect(isNavigationalHarvestQuery('solar installers near me')).toBe(false)
  expect(isNavigationalHarvestQuery('best solar installer reviews')).toBe(false)
})

test('aggregateHarvestedQueries skips non-string elements without throwing', () => {
  // A corrupted / hand-edited raw_response can carry a non-string element; it
  // must contribute no candidate rather than crash the harvest.
  const candidates = aggregateHarvestedQueries([
    { searchQueries: ['solar panel cost', 123, null, { q: 'x' }, 'best solar installer'] as unknown[] },
  ])
  expect(candidates.map(c => c.query).sort()).toEqual(['best solar installer', 'solar panel cost'])
})
