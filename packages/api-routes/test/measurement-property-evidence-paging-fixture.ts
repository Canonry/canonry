/**
 * A revision whose Property needs MORE THAN ONE default page in BOTH evidence
 * shapes.
 *
 * The shipped v2 fixture yields six flat rows, so every cursor test over it
 * crosses at most one boundary and only when an explicit small `limit` forces
 * one. A paging bug — an off-by-one at the boundary, a key that is not unique,
 * an ordering that differs between requests — survives that happily. This one
 * produces 64 answer rows and 144 flat rows for a single Property, so the
 * DEFAULT page size (50) splits both shapes and a full walk crosses several
 * boundaries.
 *
 * The run also covers the cases a "everything cited something" fixture hides:
 * answers that cited nobody (the gap the answer shape exists to show) and
 * answers whose text never landed (mention unknown, which is not "not
 * mentioned").
 */

import { measurementPlanV2Schema, type MeasurementPlanV2 } from '@canonry/canonry-contracts'
import { querySnapshots, type DatabaseClient } from '@canonry/canonry-db'

export const PAGING_CONTEXT = { label: 'Harbor', city: 'Harbor', region: 'EX', country: 'US' } as const

/** Enough questions that 2 providers each overflow the 50-row default page. */
const NODE_COUNT = 32
/** Answers with three cited URLs. 24 x 2 providers x 3 URLs = 144 flat rows. */
const CITED_NODES = 24
/** Answers that cited nobody: the loss rows the flat shape cannot represent. */
const LOSS_NODES = 6
/** Answers whose text never landed, so the mention signal is unknown. */
const SILENT_NODES = NODE_COUNT - CITED_NODES - LOSS_NODES

/** Zero-padded so the lexical order the kernel sorts by is also the readable one. */
function nodeIndexes(): readonly string[] {
  return Array.from({ length: NODE_COUNT }, (_unused, index) => String(index + 1).padStart(2, '0'))
}

export type PagingNodeKind = 'cited' | 'loss' | 'silent'

export function pagingNodeKind(index: number): PagingNodeKind {
  if (index < CITED_NODES) return 'cited'
  if (index < CITED_NODES + LOSS_NODES) return 'loss'
  return 'silent'
}

export const PAGING_NODE_COUNTS = {
  nodes: NODE_COUNT,
  cited: CITED_NODES,
  loss: LOSS_NODES,
  silent: SILENT_NODES,
  providers: 2,
} as const

/**
 * `pilot` owns every question; `sibling` shares only the first one, so a sibling
 * classification still appears and a Property-scoped read still has something to
 * exclude.
 */
export function measurementPagingPlanFixture(): MeasurementPlanV2 {
  const indexes = nodeIndexes()
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
        stableKey: 'pilot',
        label: 'Pilot Property',
        aliases: ['Pilot Property'],
        urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/pilot', pathCase: 'insensitive' }],
        mentionNotApplicable: false,
        discoveryIdentity: null,
      },
      {
        stableKey: 'sibling',
        label: 'Sibling Property',
        aliases: ['Sibling Property'],
        urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/sibling', pathCase: 'insensitive' }],
        mentionNotApplicable: false,
        discoveryIdentity: null,
      },
    ],
    groups: [
      {
        stableKey: 'regional',
        label: 'Regional comparison',
        targetKeys: ['pilot', 'sibling'],
        competitors: [
          { stableKey: 'challenger', label: 'Challenger', domain: 'challenger.example', aliases: ['Challenger'] },
        ],
      },
    ],
    querySnapshots: indexes.map(index => ({
      queryId: `q-${index}`,
      queryText: `question ${index}`,
      provenance: { source: 'manual', sourceId: null, capturedAt: '2026-07-01T00:00:00.000Z' },
    })),
    // Alternating classes so a class filter narrows to a still-multi-page half.
    assignments: [
      ...indexes.map((index, position) => ({
        targetKey: 'pilot',
        queryId: `q-${index}`,
        queryClass: position % 2 === 0 ? 'non-brand' : 'branded',
        executionNodeKey: `exec-${index}`,
      })),
      { targetKey: 'sibling', queryId: 'q-01', queryClass: 'non-brand', executionNodeKey: 'exec-01' },
    ],
    executionNodes: indexes.map(index => ({
      stableKey: `exec-${index}`,
      queryId: `q-${index}`,
      queryText: `question ${index}`,
      context: { providers: ['openai', 'gemini'], models: {}, location: PAGING_CONTEXT },
      expectedSnapshots: 2,
    })),
    usageEdges: [
      ...indexes.map(index => ({ executionNodeKey: `exec-${index}`, targetKey: 'pilot', queryId: `q-${index}` })),
      { executionNodeKey: 'exec-01', targetKey: 'sibling', queryId: 'q-01' },
    ],
    compiledChecksum: 'c'.repeat(64),
  })
}

/**
 * Three cited URLs per cited answer, one of each classification the panel has to
 * tell apart: the Property's own page, a sibling Property's, and a competitor's.
 */
function citedUrlsFor(index: string): string[] {
  return [
    `https://northstar.example/locations/pilot/${index}`,
    `https://northstar.example/locations/sibling/${index}`,
    `https://challenger.example/compare/${index}`,
  ]
}

export function seedPagingSnapshots(
  db: DatabaseClient,
  runId: string,
  plan: MeasurementPlanV2,
  now: string,
): void {
  const indexes = nodeIndexes()
  for (const [position, index] of indexes.entries()) {
    const kind = pagingNodeKind(position)
    const node = plan.executionNodes.find(candidate => candidate.stableKey === `exec-${index}`)!
    for (const provider of ['openai', 'gemini']) {
      db.insert(querySnapshots).values({
        // Deterministic ids: the kernel names an observation by its snapshot id,
        // so a random one would make the frozen baseline unreproducible.
        id: `snap-${index}-${provider}`,
        runId,
        queryId: null,
        queryText: node.queryText,
        provider,
        citationState: kind === 'loss' ? 'not-cited' : 'cited',
        answerMentioned: kind === 'silent' ? null : kind === 'cited',
        answerText: kind === 'silent'
          ? null
          : kind === 'cited'
            ? 'Pilot Property is the one people name here.'
            : 'Challenger comes up instead.',
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        measurementExecutionId: node.stableKey,
        requestedContext: node.context.location,
        supportedContext: { status: 'applied', resolved: node.context.location },
        location: node.context.location?.label ?? null,
        // An empty array, never null: null routes the kernel down the historical
        // recovery path, which is a different observation than "cited nobody".
        citedUrls: kind === 'loss' ? [] : citedUrlsFor(index),
        captureStatus: 'complete',
        createdAt: now,
      }).run()
    }
  }
}
