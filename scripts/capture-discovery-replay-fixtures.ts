/**
 * Capture REAL discovery seed sessions as replay fixtures for the
 * quality-regression suite (packages/api-routes/test/discovery-replay.test.ts).
 *
 * Runs one discovery session per ICP shape against a live engine, then embeds
 * the captured raw candidates ONCE and writes candidates + vectors + observed
 * quality metrics to test/fixtures/discovery-replay/<slug>.json. CI never
 * calls a provider: the suite replays the deterministic pipeline (brand filter
 * -> exact dedup -> cosine clustering -> representative pick -> collapse
 * warning) against these captured inputs.
 *
 * Refresh (rare, deliberate — e.g. after a major seed-prompt change):
 *   docker run -d --name canonry-replay-capture --rm -p 127.0.0.1:43001:4100 \
 *     -e CANONRY_API_KEY=<key> -e GEMINI_API_KEY=<key> \
 *     -e CANONRY_AGENT_DISABLED=1 -e DO_NOT_TRACK=1 canonry:<current>
 *   ENGINE_URL=http://127.0.0.1:43001 CANONRY_KEY=<key> GEMINI_API_KEY=<key> \
 *     npx tsx scripts/capture-discovery-replay-fixtures.ts
 * Cost: ~$0.10 per shape (one grounded seed call + one probe + one embed batch).
 * Commit the regenerated fixtures in the same PR as the change that motivated
 * the refresh, golden-fixture discipline: never regenerate to make a failing
 * assertion pass without understanding why it failed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { embedQueries } from '../packages/provider-gemini/src/index.js'
import { filterBrandedSeedCandidates, seedCollapseWarning, DISCOVERY_DEFAULT_DEDUP_THRESHOLD } from '../packages/contracts/src/index.js'
import { pickCanonicalsWithStats } from '../packages/api-routes/src/discovery/orchestrate.js'

const ENGINE = process.env.ENGINE_URL ?? 'http://127.0.0.1:43001'
const KEY = process.env.CANONRY_KEY
const GEMINI_KEY = process.env.GEMINI_API_KEY
if (!KEY || !GEMINI_KEY) throw new Error('CANONRY_KEY and GEMINI_API_KEY are required')

const OUT_DIR = path.join('packages', 'api-routes', 'test', 'fixtures', 'discovery-replay')

/** Fictional businesses only — fixtures live in a public repo. Shapes chosen
 *  to span the failure modes the performance review measured: homogeneous
 *  local (collapse-prone), multi-intent local, B2B SaaS, national e-commerce,
 *  and a problem-heavy consumer app. */
const SHAPES = [
  {
    slug: 'local-single-intent',
    displayName: 'Summit Roof Coatings',
    domain: 'summitroofcoatings.com',
    icp: 'commercial roof coating contractor in Phoenix, Arizona',
    buyer: 'commercial property managers responsible for flat-roof maintenance budgets',
    locations: [{ label: 'phoenix', city: 'Phoenix', region: 'Arizona', country: 'US' }],
  },
  {
    slug: 'local-multi-intent',
    displayName: 'Peak Comfort HVAC',
    domain: 'peakcomforthvac.com',
    icp: 'residential HVAC installation, repair, and maintenance company in Denver, Colorado',
    buyer: 'homeowners with aging furnaces or AC units comparing replacement and repair options',
    locations: [{ label: 'denver', city: 'Denver', region: 'Colorado', country: 'US' }],
  },
  {
    slug: 'b2b-saas',
    displayName: 'QuoteBeam',
    domain: 'quotebeam.io',
    icp: 'quoting and proposal software for residential solar installers',
    buyer: 'solar sales managers evaluating quoting tools for a 10-50 rep team',
    locations: [],
  },
  {
    slug: 'national-ecommerce',
    displayName: 'Willow and Sprout',
    domain: 'willowandsprout.com',
    icp: 'organic cotton baby clothing brand sold online across the US',
    buyer: 'expecting parents researching non-toxic baby essentials',
    locations: [],
  },
  {
    slug: 'problem-heavy-consumer',
    displayName: 'SwiftRemit',
    domain: 'swiftremit.app',
    icp: 'mobile app for sending money internationally with low fees',
    buyer: 'immigrants who send money home to family every month',
    locations: [],
  },
] as const

async function api(method: string, p: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${ENGINE}/api/v1${p}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as Record<string, unknown>
}

async function captureShape(shape: (typeof SHAPES)[number]): Promise<void> {
  await api('PUT', `/projects/${shape.slug}`, {
    displayName: shape.displayName,
    canonicalDomain: shape.domain,
    country: 'US',
    language: 'en',
    ...(shape.locations.length > 0
      ? { locations: shape.locations, defaultLocation: shape.locations[0]!.label }
      : {}),
  })
  const started = await api('POST', `/projects/${shape.slug}/discover/run`, {
    icpDescription: shape.icp,
    buyerDescription: shape.buyer,
    maxProbes: 1, // fixtures are about seeds/dedup; one probe completes the session cheaply
  })
  const sessionId = String(started.sessionId)
  let session: Record<string, unknown> | undefined
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const rows = (await api('GET', `/projects/${shape.slug}/discover/sessions?limit=5`)) as unknown as Array<
      Record<string, unknown>
    >
    session = rows.find((r) => r.id === sessionId)
    const status = session?.status
    if (status === 'completed') break
    if (status === 'failed') throw new Error(`${shape.slug}: session failed`)
  }
  if (session?.status !== 'completed') throw new Error(`${shape.slug}: session did not complete`)

  const candidates = session.seedRawCandidates as string[]
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(`${shape.slug}: no seedRawCandidates persisted (engine must be >= 4.109.0)`)
  }
  const vectors = await embedQueries(candidates, { apiKey: GEMINI_KEY! })
  const rounded = vectors.map((v) => v.map((x) => Math.round(x * 100_000) / 100_000))

  const fixture = {
    meta: {
      capturedWith: 'scripts/capture-discovery-replay-fixtures.ts',
      seedProvider: String(session.seedProvider ?? 'gemini'),
      icpDescription: shape.icp,
      buyerDescription: shape.buyer,
      embeddingModel: 'gemini-embedding-001',
    },
    project: {
      name: shape.slug,
      brandNames: [shape.displayName],
      canonicalDomains: [shape.domain],
    },
    seedRawCandidates: candidates,
    embeddings: Object.fromEntries(candidates.map((c, i) => [c, rounded[i]!])),
    expectedReplay,
    observed: {
      seedCountRaw: session.seedCountRaw,
      seedCount: session.seedCount,
      seedBrandFilteredCount: session.seedBrandFilteredCount,
      seedFromAnswerCount: session.seedFromAnswerCount,
      seedFromGroundingCount: session.seedFromGroundingCount,
      dedupClusterMinSims: session.dedupClusterMinSims,
      dedupBandPairFraction: session.dedupBandPairFraction,
      dedupPairsTotal: session.dedupPairsTotal,
      warning: session.warning ?? null,
    },
  }
  // Golden replay expectations: run the SAME deterministic chain the replay
  // suite runs, at capture time, so CI pins exact equality. Regenerating these
  // is a conscious act (rerun this script), never an accident.
  const embeddingByCandidate = new Map(candidates.map((c, i) => [c, rounded[i]!]))
  const { kept } = filterBrandedSeedCandidates({
    candidates,
    brandNames: [shape.displayName],
    canonicalDomains: [shape.domain],
  })
  const deduped = [...new Set(kept.map((c) => c.toLowerCase()))]
  const replayInput = kept.filter((c, i) => kept.findIndex((k) => k.toLowerCase() === c.toLowerCase()) === i)
  const { canonicals, stats } = await pickCanonicalsWithStats(
    replayInput,
    { embed: async (qs: string[]) => qs.map((q) => embeddingByCandidate.get(q)!) },
    DISCOVERY_DEFAULT_DEDUP_THRESHOLD,
  )
  const expectedReplay = {
    dedupThreshold: DISCOVERY_DEFAULT_DEDUP_THRESHOLD,
    brandDroppedCount: candidates.length - kept.length,
    postFilterCount: replayInput.length,
    canonicalCount: canonicals.length,
    canonicals,
    clusterMinSims: stats.perClusterMinSimilarity,
    bandPairFraction: stats.bandPairFraction,
    warning: seedCollapseWarning({
      seedCountRaw: replayInput.length,
      canonicalCount: canonicals.length,
      dedupThreshold: DISCOVERY_DEFAULT_DEDUP_THRESHOLD,
    }),
  }
  void deduped
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, `${shape.slug}.json`), JSON.stringify(fixture, null, 1))
  console.log(`${shape.slug}: ${candidates.length} candidates, ${String(session.seedCount)} canonicals, warning=${String(session.warning ?? 'none')}`)
}

for (const shape of SHAPES) {
  await captureShape(shape)
}
console.log('capture complete')
