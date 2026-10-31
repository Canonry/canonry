import { describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanJson,
  compileMeasurementPlan,
  measurementPlanResponseSchema,
  measurementPlanVersionResponseSchema,
  parseStoredMeasurementPlan,
  parseStoredMeasurementPlanAnyVersion,
  type MeasurementPlanInput,
  type MeasurementPlan,
} from '../src/measurement-plan.js'
import { canonicalMeasurementPlanV2Json, type MeasurementPlanV2 } from '../src/measurement-plan-v2.js'

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

const V2_PLAN: MeasurementPlanV2 = {
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
}

describe('stored measurement plan version dispatch', () => {
  it('decodes a stored v1 revision byte-identically through the v1 path', () => {
    const expected: MeasurementPlan = {
  "schemaVersion": 1,
  "defaultContext": {
    "label": "northbridge",
    "city": "Northbridge",
    "region": "NB",
    "country": "US"
  },
  "effectiveOwnedHosts": [
    "northstar.example",
    "residences.northstar.example"
  ],
  "projectCanonicalHost": "northstar.example",
  "projectBrandNames": [
    "Northstar Living",
    "northstar"
  ],
  "targets": [
    {
      "stableKey": "harbor-point",
      "label": "Harbor Point",
      "urls": [
        {
          "kind": "prefix",
          "host": "northstar.example",
          "pathPrefix": "/apartments/harbor-point",
          "pathCase": "insensitive"
        }
      ],
      "aliases": [
        "Harbor Point"
      ],
      "mentionNotApplicable": false
    }
  ],
  "groups": [],
  "targetQuerySelections": [
    {
      "targetKey": "harbor-point",
      "queryIds": [
        "q-best"
      ]
    }
  ],
  "querySnapshots": [
    {
      "queryId": "q-best",
      "queryText": "best apartments in northbridge"
    }
  ],
  "executionNodes": [
    {
      "stableKey": "execution-YmVzdCBhcGFydG1lbnRzIGluIG5vcnRoYnJpZGdlAHsiY2l0eSI6Ik5vcnRoYnJpZGdlIiwiY291bnRyeSI6IlVTIiwibGFiZWwiOiJub3J0aGJyaWRnZSIsInJlZ2lvbiI6Ik5CIn0",
      "queryText": "best apartments in northbridge",
      "context": {
        "label": "northbridge",
        "city": "Northbridge",
        "region": "NB",
        "country": "US"
      },
      "expectedSnapshots": 2
    }
  ],
  "usageEdges": [
    {
      "kind": "baseline",
      "executionNodeKey": "execution-YmVzdCBhcGFydG1lbnRzIGluIG5vcnRoYnJpZGdlAHsiY2l0eSI6Ik5vcnRoYnJpZGdlIiwiY291bnRyeSI6IlVTIiwibGFiZWwiOiJub3J0aGJyaWRnZSIsInJlZ2lvbiI6Ik5CIn0",
      "queryId": "q-best"
    },
    {
      "kind": "target",
      "executionNodeKey": "execution-YmVzdCBhcGFydG1lbnRzIGluIG5vcnRoYnJpZGdlAHsiY2l0eSI6Ik5vcnRoYnJpZGdlIiwiY291bnRyeSI6IlVTIiwibGFiZWwiOiJub3J0aGJyaWRnZSIsInJlZ2lvbiI6Ik5CIn0",
      "queryId": "q-best",
      "targetKey": "harbor-point"
    }
  ],
  "warnings": []
}
    const stored = "{\"defaultContext\":{\"city\":\"Northbridge\",\"country\":\"US\",\"label\":\"northbridge\",\"region\":\"NB\"},\"effectiveOwnedHosts\":[\"northstar.example\",\"residences.northstar.example\"],\"executionNodes\":[{\"context\":{\"city\":\"Northbridge\",\"country\":\"US\",\"label\":\"northbridge\",\"region\":\"NB\"},\"expectedSnapshots\":2,\"queryText\":\"best apartments in northbridge\",\"stableKey\":\"execution-YmVzdCBhcGFydG1lbnRzIGluIG5vcnRoYnJpZGdlAHsiY2l0eSI6Ik5vcnRoYnJpZGdlIiwiY291bnRyeSI6IlVTIiwibGFiZWwiOiJub3J0aGJyaWRnZSIsInJlZ2lvbiI6Ik5CIn0\"}],\"groups\":[],\"projectBrandNames\":[\"Northstar Living\",\"northstar\"],\"projectCanonicalHost\":\"northstar.example\",\"querySnapshots\":[{\"queryId\":\"q-best\",\"queryText\":\"best apartments in northbridge\"}],\"schemaVersion\":1,\"targetQuerySelections\":[{\"queryIds\":[\"q-best\"],\"targetKey\":\"harbor-point\"}],\"targets\":[{\"aliases\":[\"Harbor Point\"],\"label\":\"Harbor Point\",\"mentionNotApplicable\":false,\"stableKey\":\"harbor-point\",\"urls\":[{\"host\":\"northstar.example\",\"kind\":\"prefix\",\"pathCase\":\"insensitive\",\"pathPrefix\":\"/apartments/harbor-point\"}]}],\"usageEdges\":[{\"executionNodeKey\":\"execution-YmVzdCBhcGFydG1lbnRzIGluIG5vcnRoYnJpZGdlAHsiY2l0eSI6Ik5vcnRoYnJpZGdlIiwiY291bnRyeSI6IlVTIiwibGFiZWwiOiJub3J0aGJyaWRnZSIsInJlZ2lvbiI6Ik5CIn0\",\"kind\":\"baseline\",\"queryId\":\"q-best\"},{\"executionNodeKey\":\"execution-YmVzdCBhcGFydG1lbnRzIGluIG5vcnRoYnJpZGdlAHsiY2l0eSI6Ik5vcnRoYnJpZGdlIiwiY291bnRyeSI6IlVTIiwibGFiZWwiOiJub3J0aGJyaWRnZSIsInJlZ2lvbiI6Ik5CIn0\",\"kind\":\"target\",\"queryId\":\"q-best\",\"targetKey\":\"harbor-point\"}],\"warnings\":[]}"
    expect(compileMeasurementPlan(V1_INPUT, CONTEXT)).toEqual(expected)
    expect(parseStoredMeasurementPlan(stored)).toEqual(expected)
    expect(parseStoredMeasurementPlanAnyVersion(stored)).toEqual(expected)
    expect(canonicalMeasurementPlanJson(parseStoredMeasurementPlan(stored))).toBe(stored)
    expect(canonicalMeasurementPlanJson(parseStoredMeasurementPlanAnyVersion(stored) as typeof expected)).toBe(stored)
  })

  it('decodes a stored v2 revision through the new v2 case', () => {
    const stored = "{\"assignments\":[{\"executionNodeKey\":\"exec-best\",\"queryClass\":\"non-brand\",\"queryId\":\"q-best\",\"targetKey\":\"harbor-point\"}],\"compiledChecksum\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"executionNodes\":[{\"context\":{\"location\":{\"city\":\"Northbridge\",\"country\":\"US\",\"label\":\"northbridge\",\"region\":\"NB\"},\"models\":{\"gemini\":\"gemini-3-pro\"},\"providers\":[\"gemini\"]},\"expectedSnapshots\":1,\"queryId\":\"q-best\",\"queryText\":\"best apartments in northbridge\",\"stableKey\":\"exec-best\"}],\"groups\":[],\"identities\":{\"projectBrand\":{\"canonicalHost\":\"northstar.example\",\"names\":[\"Northstar Living\"],\"ownedHosts\":[\"northstar.example\"]}},\"querySnapshots\":[{\"provenance\":{\"capturedAt\":\"2026-08-01T00:00:00.000Z\",\"source\":\"manual\",\"sourceId\":null},\"queryId\":\"q-best\",\"queryText\":\"best apartments in northbridge\"}],\"schemaVersion\":2,\"targets\":[{\"aliases\":[\"Harbor Point\"],\"discoveryIdentity\":null,\"label\":\"Harbor Point\",\"mentionNotApplicable\":false,\"stableKey\":\"harbor-point\",\"urlMatchers\":[{\"host\":\"northstar.example\",\"kind\":\"prefix\",\"pathCase\":\"insensitive\",\"pathPrefix\":\"/apartments/harbor-point\"}]}],\"usageEdges\":[{\"executionNodeKey\":\"exec-best\",\"queryId\":\"q-best\",\"targetKey\":\"harbor-point\"}]}"
    expect(parseStoredMeasurementPlanAnyVersion(V2_PLAN)).toEqual(V2_PLAN)
    expect(parseStoredMeasurementPlanAnyVersion(stored)).toEqual(V2_PLAN)
    expect(canonicalMeasurementPlanV2Json(parseStoredMeasurementPlanAnyVersion(stored) as MeasurementPlanV2)).toBe(stored)
  })

  it('types v2 plans on both active and revision-detail read responses', () => {
    const metadata = {
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
