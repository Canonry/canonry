import { queryTrackingWorkspaceResponseSchema } from '@ainyc/canonry-contracts'
import type { QueryClass, QueryTrackingContextInput, QueryTrackingTrackedRow } from '@ainyc/canonry-contracts'

import type { TrackedPlace } from '../../src/components/project/queries/advanced/tracked-actions.js'
import type { TrackedRowVm, TrackedSubject } from '../../src/components/project/queries/advanced/tracked-types.js'

// One portfolio shared by the tracked-actions, tracked-row-menu and tracked-action-sheet tests.

export const workspaceVersion = `qtw_${'a'.repeat(64)}`
const context = {
  providers: ['openai' as const],
  models: { openai: 'gpt-5' },
  location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' },
}
/** Two search location and engines choices, as the Add queries sheet's caller builds them. */
export const contextChoices: { label: string; input: QueryTrackingContextInput }[] = [
  { label: 'New York · openai (gpt-5)', input: { providers: ['openai'], models: { openai: 'gpt-5' }, location: 'New York' } },
  { label: 'Boston · openai (gpt-5)', input: { providers: ['openai'], models: { openai: 'gpt-5' }, location: 'Boston' } },
]

type Pairing = QueryTrackingTrackedRow['assignments'][number]

function pairing(targetKey: string, marketKeys: string[], queryClass: QueryClass, classificationSource: Pairing['classificationSource'] = 'server'): Pairing {
  return { targetKey, groupKeys: [], marketKeys, queryClass, classificationSource, contexts: [context] }
}

/** A Tracked row as the view model builds it from one workspace row. */
function row(queryId: string, queryText: string, subject: TrackedSubject, assignments: Pairing[]): TrackedRowVm {
  const queryClasses = [...new Set(assignments.map(assignment => assignment.queryClass).filter((value): value is QueryClass => value !== null))].sort()
  return {
    queryId,
    queryText,
    subject,
    type: queryClasses.length === 0 ? 'not-set' : queryClasses.length === 1 ? queryClasses[0]! : 'mixed',
    queryClasses,
    status: subject.kind === 'none' ? 'not-asked' : 'measured',
    source: { kind: 'manual' },
    lastMeasuredAt: null,
    addedAt: null,
    tracked: { queryId, queryText, normalizedText: queryText.toLowerCase(), provenance: null, state: 'tracked', lastMeasuredAt: null, assignments, queryClasses },
  }
}

const UPTOWN: TrackedSubject = { kind: 'market', key: 'uptown', label: 'Uptown', locationCount: 3 }
const HARBOR: TrackedSubject = { kind: 'location', key: 'harbor', label: 'Harbor Point' }
const uptownPairings = () => ['harbor', 'river', 'summit'].map(targetKey => pairing(targetKey, ['uptown'], 'non-brand'))

/**
 * Five locations:
 * - Uptown holds Harbor Point, River Point and Summit Lofts.
 * - Downtown holds Harbor Point alone, which also sits in Uptown, so a query there is still told apart by its pairings.
 * - Solo holds Pier House alone and Pier House sits nowhere else: there a query's type alone sets its Subject.
 * - Lone Pine is in no market.
 */
export const rows = {
  market: row('q-uptown', 'best apartments uptown', UPTOWN, uptownPairings()),
  marketB: row('q-uptown-b', 'uptown apartments with parking', UPTOWN, uptownPairings()),
  marketC: row('q-uptown-c', 'pet friendly apartments uptown', UPTOWN, uptownPairings()),
  downtown: row('q-downtown', 'best apartments downtown', { kind: 'market', key: 'downtown', label: 'Downtown', locationCount: 1 }, [pairing('harbor', ['downtown'], 'non-brand')]),
  location: row('q-harbor', 'Harbor Point reviews', HARBOR, [pairing('harbor', ['uptown', 'downtown'], 'branded')]),
  /** A location query an operator set to Non-brand, although its text names the location. */
  operatorSet: row('q-harbor-parking', 'Harbor Point parking', HARBOR, [pairing('harbor', ['uptown', 'downtown'], 'non-brand', 'operator')]),
  handPicked: row('q-picked', 'apartments with a pool', { kind: 'hand-picked', locationCount: 2 }, [pairing('harbor', ['uptown'], 'non-brand'), pairing('pier', [], 'non-brand')]),
  soloMarket: row('q-solo', 'apartments near the pier', { kind: 'market', key: 'solo', label: 'Solo', locationCount: 1 }, [pairing('pier', ['solo'], 'non-brand')]),
  soloLocation: row('q-pier', 'Pier House reviews', { kind: 'location', key: 'pier', label: 'Pier House' }, [pairing('pier', ['solo'], 'branded')]),
  notAsked: row('q-old', 'apartments in the old town', { kind: 'none' }, []),
}

const edge = (targetKey: string, queryId: string) => ({ executionNodeKey: `node-${queryId}`, targetKey, queryId })
const location = (id: string, label: string) => ({ id, label, kind: 'property' as const, targetCount: 1 })
const market = (id: string, label: string, targetCount: number) => ({ id, label, kind: 'market' as const, targetCount })

/** Parsed with the response schema, so the fixture is a workspace the server could send. */
export const workspace = queryTrackingWorkspaceResponseSchema.parse({
  mode: 'advanced',
  workspaceVersion,
  active: { revision: 4, compiledChecksum: 'c'.repeat(64) },
  defaultContexts: [context],
  targets: [
    { stableKey: 'harbor', label: 'Harbor Point' },
    { stableKey: 'river', label: 'River Point' },
    { stableKey: 'summit', label: 'Summit Lofts' },
    { stableKey: 'pier', label: 'Pier House' },
    { stableKey: 'lone', label: 'Lone Pine' },
  ],
  groups: [],
  markets: [
    { stableKey: 'uptown', label: 'Uptown', usageEdges: ['harbor', 'river', 'summit'].flatMap(targetKey => ['q-uptown', 'q-uptown-b'].map(queryId => edge(targetKey, queryId))) },
    { stableKey: 'downtown', label: 'Downtown', usageEdges: [edge('harbor', 'q-downtown'), edge('harbor', 'q-harbor')] },
    { stableKey: 'solo', label: 'Solo', usageEdges: [edge('pier', 'q-solo')] },
  ],
  scopeOptions: [
    { id: 'project', label: 'Project', kind: 'project', targetCount: 5 },
    market('uptown', 'Uptown', 3),
    market('downtown', 'Downtown', 1),
    market('solo', 'Solo', 1),
    location('harbor', 'Harbor Point'),
    location('river', 'River Point'),
    location('summit', 'Summit Lofts'),
    location('pier', 'Pier House'),
    location('lone', 'Lone Pine'),
  ],
  tracked: Object.values(rows).map(tracked => tracked.tracked),
  savedSources: { research: [], discovery: [] },
})

export const uptownPlace: TrackedPlace = { kind: 'market', key: 'uptown', label: 'Uptown' }
