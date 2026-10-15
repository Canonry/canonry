/**
 * One published schema-v2 revision, shared by the adapter and overview suites.
 *
 * `exec-nearby` is deliberately reused by both Properties: it is the fixture
 * that proves reuse adds usage edges rather than expected slots. `exec-brand`
 * is the Branded basket, so a class filter has something to exclude.
 */

import { measurementPlanV2Schema, type MeasurementPlanV2 } from '@canonry/canonry-contracts'

export const HARBOR_CONTEXT = { label: 'Harbor', city: 'Harbor', region: 'EX', country: 'US' } as const

export function measurementPlanV2Fixture(overrides: Partial<MeasurementPlanV2> = {}): MeasurementPlanV2 {
  return measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: {
      projectBrand: {
        canonicalHost: 'northstar.example',
        ownedHosts: ['northstar.example'],
        names: ['Northstar'],
      },
    },
    targets: [
      {
        stableKey: 'harbor',
        label: 'Harbor Homes',
        aliases: ['Harbor Homes'],
        urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/harbor', pathCase: 'insensitive' }],
        mentionNotApplicable: false,
        discoveryIdentity: null,
      },
      {
        stableKey: 'bayside',
        label: 'Bayside Homes',
        aliases: ['Bayside Homes'],
        urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/bayside', pathCase: 'insensitive' }],
        mentionNotApplicable: false,
        discoveryIdentity: null,
      },
    ],
    groups: [
      {
        stableKey: 'regional',
        label: 'Regional comparison',
        targetKeys: ['harbor', 'bayside'],
        competitors: [
          { stableKey: 'challenger', label: 'Challenger', domain: 'challenger.example', aliases: ['Challenger'] },
        ],
      },
    ],
    querySnapshots: [
      {
        queryId: 'q-nearby',
        queryText: 'homes near harbor',
        provenance: { source: 'manual', sourceId: null, capturedAt: '2026-07-01T00:00:00.000Z' },
      },
      {
        queryId: 'q-brand',
        queryText: 'northstar reviews',
        provenance: { source: 'manual', sourceId: null, capturedAt: '2026-07-01T00:00:00.000Z' },
      },
    ],
    assignments: [
      { targetKey: 'harbor', queryId: 'q-nearby', queryClass: 'non-brand', executionNodeKey: 'exec-nearby' },
      { targetKey: 'bayside', queryId: 'q-nearby', queryClass: 'non-brand', executionNodeKey: 'exec-nearby' },
      { targetKey: 'harbor', queryId: 'q-brand', queryClass: 'branded', executionNodeKey: 'exec-brand' },
    ],
    executionNodes: [
      {
        stableKey: 'exec-nearby',
        queryId: 'q-nearby',
        queryText: 'homes near harbor',
        context: { providers: ['openai', 'gemini'], models: {}, location: HARBOR_CONTEXT },
        expectedSnapshots: 2,
      },
      {
        stableKey: 'exec-brand',
        queryId: 'q-brand',
        queryText: 'northstar reviews',
        context: { providers: ['openai', 'gemini'], models: {}, location: HARBOR_CONTEXT },
        expectedSnapshots: 2,
      },
    ],
    usageEdges: [
      { executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' },
      { executionNodeKey: 'exec-nearby', targetKey: 'bayside', queryId: 'q-nearby' },
      { executionNodeKey: 'exec-brand', targetKey: 'harbor', queryId: 'q-brand' },
    ],
    compiledChecksum: 'b'.repeat(64),
    ...overrides,
  })
}
