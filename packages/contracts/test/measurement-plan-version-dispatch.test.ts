import { describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanJson,
  compileMeasurementPlan,
  measurementPlanResponseSchema,
  measurementPlanVersionResponseSchema,
  parseStoredMeasurementPlan,
  parseStoredMeasurementPlanAnyVersion,
  type MeasurementPlanInput,
} from '../src/measurement-plan.js'
import { canonicalMeasurementPlanV2Json, measurementPlanV2Schema } from '../src/measurement-plan-v2.js'

const NORTHBRIDGE = { label: 'northbridge', city: 'Northbridge', region: 'NB', country: 'US' }

const CONTEXT = {
  canonicalDomain: 'https://www.northstar.example/',
  ownedDomains: ['residences.northstar.example'],
  brandNames: ['Northstar Living'],
  defaultContext: NORTHBRIDGE,
  locations: [NORTHBRIDGE],
  trackedQueries: [{ id: 'q-best', query: 'best apartments in northbridge' }],
  expectedSnapshots: 2,
}

const V1_INPUT: MeasurementPlanInput = {
  schemaVersion: 1,
  targets: [{
    stableKey: 'harbor-point',
    label: 'Harbor Point',
    urls: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/apartments/harbor-point', pathCase: 'insensitive' }],
    aliases: ['Harbor Point'],
  }],
  targetQuerySelections: [{ targetKey: 'harbor-point', queryIds: ['q-best'] }],
}

const V2_PLAN = measurementPlanV2Schema.parse({
  schemaVersion: 2,
  identities: {
    projectBrand: {
      canonicalHost: 'northstar.example',
      ownedHosts: ['northstar.example'],
      names: ['Northstar Living'],
    },
  },
  targets: [{
    stableKey: 'harbor-point',
    label: 'Harbor Point',
    aliases: ['Harbor Point'],
    urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/apartments/harbor-point', pathCase: 'insensitive' }],
    mentionNotApplicable: false,
    discoveryIdentity: null,
  }],
  groups: [],
  querySnapshots: [{
    queryId: 'q-best',
    queryText: 'best apartments in northbridge',
    provenance: { source: 'manual', sourceId: null, capturedAt: '2026-08-01T00:00:00.000Z' },
  }],
  assignments: [{ targetKey: 'harbor-point', queryId: 'q-best', queryClass: 'non-brand', executionNodeKey: 'exec-best' }],
  executionNodes: [{
    stableKey: 'exec-best',
    queryId: 'q-best',
    queryText: 'best apartments in northbridge',
    context: { providers: ['gemini'], models: { gemini: 'gemini-3-pro' }, location: NORTHBRIDGE },
    expectedSnapshots: 1,
  }],
  usageEdges: [{ executionNodeKey: 'exec-best', targetKey: 'harbor-point', queryId: 'q-best' }],
  compiledChecksum: 'c'.repeat(64),
})

describe('stored measurement plan version dispatch', () => {
  it('decodes a stored v1 revision byte-identically through the v1 path', () => {
    const compiled = compileMeasurementPlan(V1_INPUT, CONTEXT)
    const stored = canonicalMeasurementPlanJson(compiled)

    expect(parseStoredMeasurementPlan(stored)).toEqual(compiled)
    expect(canonicalMeasurementPlanJson(parseStoredMeasurementPlan(stored))).toBe(stored)
    expect(parseStoredMeasurementPlanAnyVersion(stored)).toEqual(compiled)
    expect(canonicalMeasurementPlanJson(parseStoredMeasurementPlanAnyVersion(stored) as typeof compiled)).toBe(stored)
  })

  it('decodes a stored v2 revision through the new v2 case', () => {
    const stored = canonicalMeasurementPlanV2Json(V2_PLAN)

    expect(parseStoredMeasurementPlanAnyVersion(V2_PLAN)).toEqual(V2_PLAN)
    expect(parseStoredMeasurementPlanAnyVersion(stored)).toEqual(V2_PLAN)
  })

  it('types v2 plans on both active and revision-detail read responses', () => {
    const metadata = {
      id: 'version-active',
      revision: 2,
      checksum: 'd'.repeat(64),
      createdAt: '2026-08-01T00:00:00.000Z',
    }

    expect(measurementPlanResponseSchema.parse({ active: { ...metadata, plan: V2_PLAN } }).active?.plan)
      .toEqual(V2_PLAN)
    expect(measurementPlanVersionResponseSchema.parse({
      version: { ...metadata, active: true, plan: V2_PLAN },
    }).version.plan).toEqual(V2_PLAN)
  })

  it('refuses a malformed v2 revision instead of falling back to v1', () => {
    expect(() => parseStoredMeasurementPlanAnyVersion({ schemaVersion: 2, targets: [] }))
      .toThrow('Stored measurement plan v2 is invalid')
  })

  it('still throws on an unknown schema version', () => {
    expect(() => parseStoredMeasurementPlanAnyVersion({ ...V2_PLAN, schemaVersion: 3 }))
      .toThrow('Unsupported stored measurement plan schema version: 3')
    expect(() => parseStoredMeasurementPlan({ ...V2_PLAN, schemaVersion: 3 }))
      .toThrow('Unsupported stored measurement plan schema version: 3')
  })

  it('refuses to hand a v2 revision to a v1-only reader', () => {
    // Silently typing a v2 document as v1 is the failure this prevents: every
    // v1 field the caller then reads would be undefined at runtime.
    expect(() => parseStoredMeasurementPlan(V2_PLAN))
      .toThrow('Stored measurement plan revision is schema v2, which this reader does not understand')
  })
})
