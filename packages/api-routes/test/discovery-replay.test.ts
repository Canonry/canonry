import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  filterBrandedSeedCandidates,
  seedCollapseWarning,
} from '@ainyc/canonry-contracts'
import { dedupeStrings, pickCanonicalsWithStats } from '../src/discovery/orchestrate.js'

/**
 * Discovery quality-regression replay suite.
 *
 * Each fixture is a REAL captured seed session (raw candidates + their
 * embedding vectors + golden expectations computed at capture time by
 * scripts/capture-discovery-replay-fixtures.ts). The suite replays the full
 * deterministic seed pipeline — brand filter → exact dedup → cosine
 * clustering → representative pick → collapse warning — with ZERO provider
 * calls, so any change to that chain shows up as a diff against real data
 * from five distinct ICP shapes.
 *
 * Two assertion tiers:
 *  - GOLDEN equality: same code + same inputs must reproduce the captured
 *    outputs exactly. A deliberate logic change regenerates fixtures via the
 *    capture script IN THE SAME PR, with the diff reviewed — never loosen an
 *    assertion to make it pass.
 *  - INVARIANTS: quality floors that must hold for every healthy shape no
 *    matter how the logic evolves (enough canonicals to pass the platform
 *    gate, no collapse warning, bounded brand leakage).
 */
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'discovery-replay')

interface ReplayFixture {
  project: { name: string; brandNames: string[]; canonicalDomains: string[] }
  seedRawCandidates: string[]
  embeddings: Record<string, number[]>
  expectedReplay: {
    dedupThreshold: number
    brandDroppedCount: number
    postFilterCount: number
    canonicalCount: number
    canonicals: string[]
    clusterMinSims: number[]
    bandPairFraction: number | null
    warning: string | null
  }
}

const fixtures = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, fixture: JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) as ReplayFixture }))

/** The platform's absolute canonical floor (checkDiscoverySession). A healthy
 *  captured shape regressing below it means real paid runs would start dying. */
const PLATFORM_CANONICAL_FLOOR = 8

describe('discovery seed pipeline replay (captured real sessions, no provider calls)', () => {
  it('found the fixture corpus', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5)
  })

  for (const { file, fixture } of fixtures) {
    describe(file, () => {
      async function replay() {
        const { kept, droppedBranded } = filterBrandedSeedCandidates({
          candidates: fixture.seedRawCandidates,
          brandNames: fixture.project.brandNames,
          canonicalDomains: fixture.project.canonicalDomains,
        })
        const deduped = dedupeStrings(kept)
        const { canonicals, stats } = await pickCanonicalsWithStats(
          deduped,
          { embed: async (qs) => qs.map((q) => fixture.embeddings[q]!) },
          fixture.expectedReplay.dedupThreshold,
        )
        return { droppedBranded, deduped, canonicals, stats }
      }

      it('reproduces the golden capture exactly', async () => {
        const { droppedBranded, deduped, canonicals, stats } = await replay()
        expect(droppedBranded.length).toBe(fixture.expectedReplay.brandDroppedCount)
        expect(deduped.length).toBe(fixture.expectedReplay.postFilterCount)
        expect(canonicals).toEqual(fixture.expectedReplay.canonicals)
        expect(stats.perClusterMinSimilarity).toEqual(fixture.expectedReplay.clusterMinSims)
        expect(stats.bandPairFraction).toBe(fixture.expectedReplay.bandPairFraction)
      })

      it('holds the quality invariants (gate floor, no collapse, bounded brand leakage)', async () => {
        const { droppedBranded, deduped, canonicals } = await replay()
        expect(canonicals.length).toBeGreaterThanOrEqual(PLATFORM_CANONICAL_FLOOR)
        const warning = seedCollapseWarning({
          seedCountRaw: deduped.length,
          canonicalCount: canonicals.length,
          dedupThreshold: fixture.expectedReplay.dedupThreshold,
        })
        expect(warning).toBeNull()
        // The no-brand prompt rule should carry the weight; the filter is the
        // backstop. More than 20% branded raw candidates means the prompt rule
        // regressed even if the filter caught the leakage.
        expect(droppedBranded.length / fixture.seedRawCandidates.length).toBeLessThanOrEqual(0.2)
      })

      it('embeds every candidate exactly once in the fixture (capture integrity)', () => {
        for (const candidate of fixture.seedRawCandidates) {
          expect(fixture.embeddings[candidate], `missing embedding for: ${candidate}`).toBeDefined()
        }
      })
    })
  }
})
