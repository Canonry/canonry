import { describe, expect, it } from 'vitest'
import { measurementStableKeySchema } from '../src/measurement-plan.js'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  canonicalMeasurementPlanV2Json,
  measurementMetricValueSchema,
  measurementOverviewQuerySchema,
  measurementOverviewResponseSchema,
  measurementOverviewSortSchema,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  measurementPropertyEvidenceQuerySchema,
  measurementV2StableKeySchema,
  type MeasurementPlanV2,
} from '../src/measurement-plan-v2.js'

const NORTHBRIDGE = { label: 'northbridge', city: 'Northbridge', region: 'NB', country: 'US' }
const CHECKSUM = 'a'.repeat(64)

function planV2(): MeasurementPlanV2 {
  return measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: {
      projectBrand: {
        canonicalHost: 'northstar.example',
        ownedHosts: ['northstar.example', 'residences.northstar.example'],
        names: ['Northstar Living'],
      },
    },
    targets: [
      {
        stableKey: 'harbor-point',
        label: 'Harbor Point',
        aliases: ['Harbor Point'],
        urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/apartments/harbor-point', pathCase: 'insensitive' }],
        mentionNotApplicable: false,
        discoveryIdentity: 'northstar.example/apartments/{slug}#harbor-point',
      },
      {
        stableKey: 'sail-loft',
        label: 'Sail Loft',
        aliases: [],
        urlMatchers: [{ kind: 'host', host: 'residences.northstar.example' }],
        mentionNotApplicable: true,
        discoveryIdentity: null,
      },
    ],
    groups: [
      {
        stableKey: 'northbridge-portfolio',
        label: 'Northbridge portfolio',
        targetKeys: ['harbor-point', 'sail-loft'],
        competitors: [
          { stableKey: 'harborview', label: 'Harborview', domain: 'harborview.example', aliases: ['Harborview'] },
        ],
      },
    ],
    querySnapshots: [
      {
        queryId: 'q-best',
        queryText: 'best apartments in northbridge',
        provenance: { source: 'manual', sourceId: null, capturedAt: '2026-08-01T00:00:00.000Z' },
      },
      {
        queryId: 'q-northstar',
        queryText: 'northstar apartments',
        provenance: { source: 'template', sourceId: 'tpl-brand', capturedAt: '2026-08-01T00:00:00.000Z' },
      },
    ],
    assignments: [
      { targetKey: 'harbor-point', queryId: 'q-best', queryClass: 'non-brand', executionNodeKey: 'exec-best' },
      { targetKey: 'harbor-point', queryId: 'q-northstar', queryClass: 'branded', executionNodeKey: 'exec-northstar' },
      { targetKey: 'sail-loft', queryId: 'q-best', queryClass: 'non-brand', executionNodeKey: 'exec-best' },
    ],
    executionNodes: [
      {
        stableKey: 'exec-best',
        queryId: 'q-best',
        queryText: 'best apartments in northbridge',
        context: { providers: ['gemini', 'openai'], models: { gemini: 'gemini-3-pro', openai: 'gpt-5.4' }, location: NORTHBRIDGE },
        expectedSnapshots: 2,
      },
      {
        stableKey: 'exec-northstar',
        queryId: 'q-northstar',
        queryText: 'northstar apartments',
        context: { providers: ['gemini', 'openai'], models: { gemini: 'gemini-3-pro', openai: 'gpt-5.4' }, location: null },
        expectedSnapshots: 2,
      },
    ],
    usageEdges: [
      { executionNodeKey: 'exec-best', targetKey: 'harbor-point', queryId: 'q-best' },
      { executionNodeKey: 'exec-best', targetKey: 'sail-loft', queryId: 'q-best' },
      { executionNodeKey: 'exec-northstar', targetKey: 'harbor-point', queryId: 'q-northstar' },
    ],
    compiledChecksum: CHECKSUM,
  })
}

describe('published measurement plan v2', () => {
  it('pins the schema version and round-trips a compiled revision', () => {
    const plan = planV2()
    expect(MEASUREMENT_PLAN_V2_SCHEMA_VERSION).toBe(2)
    expect(plan.schemaVersion).toBe(2)
    expect(measurementPlanV2Schema.parse(plan)).toEqual(plan)
  })

  it('rejects unknown keys so a compiler cannot smuggle authoring state into a published revision', () => {
    const plan = planV2()
    expect(() => measurementPlanV2Schema.parse({ ...plan, targetQuerySelections: [] })).toThrow()
  })

  it('requires a compiled checksum on every published revision', () => {
    const { compiledChecksum: _dropped, ...withoutChecksum } = planV2()
    expect(() => measurementPlanV2Schema.parse(withoutChecksum)).toThrow()
  })

  it('accepts the v2 stable key vocabulary exactly where v1 does', () => {
    const cases = ['harbor-point', 'Harbor.Point~1', 'a', '9lives', '-leading-dash', '', 'has space', 'x'.repeat(129)]
    for (const value of cases) {
      expect(
        measurementV2StableKeySchema.safeParse(value).success,
        `v2 stable key disagrees with v1 on ${JSON.stringify(value)}`,
      ).toBe(measurementStableKeySchema.safeParse(value).success)
    }
  })
})

describe('measurement plan v2 canonical ordering', () => {
  it('orders provider configuration too, not only the assignment list', () => {
    const plan = planV2()
    const shuffled: MeasurementPlanV2 = {
      ...plan,
      identities: {
        projectBrand: { ...plan.identities.projectBrand, ownedHosts: [...plan.identities.projectBrand.ownedHosts].reverse() },
      },
      targets: [...plan.targets].reverse(),
      groups: plan.groups.map(group => ({ ...group, targetKeys: [...group.targetKeys].reverse() })),
      querySnapshots: [...plan.querySnapshots].reverse(),
      assignments: [...plan.assignments].reverse(),
      usageEdges: [...plan.usageEdges].reverse(),
      executionNodes: [...plan.executionNodes].reverse().map(node => ({
        ...node,
        context: {
          ...node.context,
          providers: [...node.context.providers].reverse(),
          models: { openai: node.context.models.openai!, gemini: node.context.models.gemini! },
        },
      })),
    }

    expect(canonicalMeasurementPlanV2Json(shuffled)).toBe(canonicalMeasurementPlanV2Json(plan))
  })

  it('excludes the checksum field from the bytes the checksum is taken over', () => {
    const plan = planV2()
    const rehashed: MeasurementPlanV2 = { ...plan, compiledChecksum: 'b'.repeat(64) }

    expect(measurementPlanV2ChecksumJson(rehashed)).toBe(measurementPlanV2ChecksumJson(plan))
    expect(measurementPlanV2ChecksumJson(plan)).not.toContain('compiledChecksum')
    expect(canonicalMeasurementPlanV2Json(plan)).toContain('compiledChecksum')
  })

  it('gives different content different checksum bytes', () => {
    const plan = planV2()
    const changed: MeasurementPlanV2 = {
      ...plan,
      assignments: plan.assignments.map(assignment => ({ ...assignment, queryClass: 'branded' as const })),
    }
    expect(measurementPlanV2ChecksumJson(changed)).not.toBe(measurementPlanV2ChecksumJson(plan))
  })
})

describe('measurement metric value', () => {
  it('serializes an unavailable metric without any numeric field', () => {
    const unavailable = measurementMetricValueSchema.parse({ state: 'unavailable', reason: 'no_completed_run' })
    expect(unavailable).toEqual({ state: 'unavailable', reason: 'no_completed_run' })
    expect(JSON.stringify(unavailable)).not.toContain('0')
    expect(Object.keys(unavailable)).not.toContain('value')
  })

  it('refuses an unavailable metric that also carries a value', () => {
    expect(() => measurementMetricValueSchema.parse({ state: 'unavailable', reason: 'plan_v1', value: 0 })).toThrow()
  })

  it('carries the numerator and denominator an available rate rests on', () => {
    expect(measurementMetricValueSchema.parse({ state: 'available', value: 0.5, numerator: 3, denominator: 6 }))
      .toEqual({ state: 'available', value: 0.5, numerator: 3, denominator: 6 })
  })

  it('carries a bounded server-computed rate beside a count value', () => {
    expect(measurementMetricValueSchema.parse({ state: 'available', value: 3, numerator: 3, denominator: 6, rate: 0.5 }))
      .toEqual({ state: 'available', value: 3, numerator: 3, denominator: 6, rate: 0.5 })
    expect(measurementMetricValueSchema.safeParse({ state: 'available', value: 3, rate: -0.1 }).success).toBe(false)
    expect(measurementMetricValueSchema.safeParse({ state: 'available', value: 3, rate: 1.1 }).success).toBe(false)
  })
})

describe('measurement overview response', () => {
  const unavailable = { state: 'unavailable', reason: 'no_completed_run' } as const

  function overview() {
    return {
      mode: 'active-v2',
      scope: { kind: 'all', label: 'All Properties' },
      queryClass: 'all',
      measurement: { state: 'not_measured', completed: 0, expected: 0, includesHistoricalData: false },
      nextAction: { kind: 'run_measurement' },
      metrics: {
        propertiesMentioned: unavailable,
        mentionCoverage: unavailable,
        citationCoverage: unavailable,
        brandPresence: unavailable,
        sov: unavailable,
      },
      properties: { items: [], nextCursor: null },
      outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 1 },
      flags: { total: 0 },
    }
  }

  it('emits brandPresence and keeps sov as its deprecated alias', () => {
    const parsed = measurementOverviewResponseSchema.parse(overview())
    expect(parsed.metrics.brandPresence).toEqual(unavailable)
    expect(parsed.metrics.sov).toEqual(parsed.metrics.brandPresence)
    expect(parsed.measurement.includesHistoricalData).toBe(false)
  })

  it('refuses a response that drops the deprecated sov alias while the browser still reads it', () => {
    const { sov: _dropped, ...metrics } = overview().metrics
    expect(() => measurementOverviewResponseSchema.parse({ ...overview(), metrics })).toThrow()
  })

  it('accepts an explicit run selection on the query', () => {
    const parsed = measurementOverviewQuerySchema.parse({ scope: 'group', groupKey: 'northbridge-portfolio', runId: 'run-7' })
    expect(parsed).toEqual({ scope: 'group', groupKey: 'northbridge-portfolio', runId: 'run-7' })
  })

  it('accepts the explicit, direction-aware Property sort vocabulary', () => {
    expect(measurementOverviewSortSchema.options).toEqual([
      'label-asc',
      'label-desc',
      'citationCoverage-asc',
      'citationCoverage-desc',
      'mentionCoverage-asc',
      'mentionCoverage-desc',
    ])
    expect(measurementOverviewQuerySchema.parse({ scope: 'all', sort: 'citationCoverage-desc' }).sort)
      .toBe('citationCoverage-desc')
    expect(() => measurementOverviewQuerySchema.parse({ scope: 'all', sort: 'citationCoverage' })).toThrow()
  })

  it('caps the page limit so a Target list cannot be pulled unbounded', () => {
    expect(() => measurementOverviewQuerySchema.parse({ scope: 'all', limit: 101 })).toThrow()
    expect(measurementOverviewQuerySchema.parse({ scope: 'all', limit: 100 }).limit).toBe(100)
  })
})

// The runner dedups execution nodes by slot identity and skips the loser. If a
// usage edge points at a node that is missing, or at one of two nodes sharing a
// key, the edge's Target is silently never measured: no error, just a Target
// quietly absent from the sweep. That is the exact class of wrong number this
// model exists to prevent, so such a revision must not decode at all.
describe('v2 referential integrity', () => {
  it('refuses a usage edge pointing at an execution node that does not exist', () => {
    const plan = planV2()
    plan.usageEdges.push({ executionNodeKey: 'exec-missing', targetKey: 'harbor-point', queryId: 'q-best' })

    const result = measurementPlanV2Schema.safeParse(plan)

    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('unknown execution node')
  })

  it('refuses two execution nodes sharing a stable key', () => {
    const plan = planV2()
    plan.executionNodes.push({ ...plan.executionNodes[0]!, queryText: 'a different question' })

    const result = measurementPlanV2Schema.safeParse(plan)

    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('Duplicate execution node key')
  })

  it('refuses an edge, an assignment or a group naming a Target that does not exist', () => {
    const edge = planV2()
    edge.usageEdges.push({ executionNodeKey: 'exec-best', targetKey: 'ghost', queryId: 'q-best' })
    expect(measurementPlanV2Schema.safeParse(edge).success).toBe(false)

    const assignment = planV2()
    assignment.assignments.push({ targetKey: 'ghost', queryId: 'q-best', queryClass: 'non-brand', executionNodeKey: 'exec-best' })
    expect(measurementPlanV2Schema.safeParse(assignment).success).toBe(false)

    const group = planV2()
    group.groups[0]!.targetKeys.push('ghost')
    expect(measurementPlanV2Schema.safeParse(group).success).toBe(false)
  })

  it('still accepts a plan whose edges all resolve', () => {
    expect(measurementPlanV2Schema.safeParse(planV2()).success).toBe(true)
  })

  it('reads the evidence shape as an opt-in, defaulting by absence to the published per-URL rows', () => {
    const omitted = measurementPropertyEvidenceQuerySchema.parse({ targetKey: 'harbor' })
    expect(omitted.shape).toBeUndefined()

    expect(measurementPropertyEvidenceQuerySchema.parse({ targetKey: 'harbor', shape: 'sources' }).shape).toBe('sources')
    expect(measurementPropertyEvidenceQuerySchema.parse({ targetKey: 'harbor', shape: 'answers' }).shape).toBe('answers')
    expect(measurementPropertyEvidenceQuerySchema.safeParse({ targetKey: 'harbor', shape: 'urls' }).success).toBe(false)
  })
})
