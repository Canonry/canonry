import type { DiscoverySessionDto } from '@ainyc/canonry-contracts'

/**
 * Discovery quality eval: the live half of the discovery regression harness.
 * The replay suite (api-routes test fixtures) pins the deterministic pipeline;
 * this panel measures what replay cannot see — seed-prompt changes, provider
 * behaviour drift — by running REAL sessions against a live instance and
 * comparing per-shape scorecards to a committed baseline.
 *
 * Everything here is pure (scoring + comparison); the orchestration lives in
 * `commands/discover-eval.ts`.
 */

export interface DiscoveryEvalShape {
  /** Project name the eval runs under (idempotent PUT; `eval-` prefix). */
  slug: string
  displayName: string
  domain: string
  icp: string
  buyer: string
  locations: ReadonlyArray<{ label: string; city: string; region: string; country: string }>
}

/** Fictional businesses spanning the measured failure modes: homogeneous
 *  local (collapse-prone), multi-intent local, B2B SaaS, national e-commerce,
 *  problem-heavy consumer. Keep in sync with the replay-fixture shapes. */
export const DISCOVERY_EVAL_PANEL: readonly DiscoveryEvalShape[] = [
  {
    slug: 'eval-local-single-intent',
    displayName: 'Summit Roof Coatings',
    domain: 'summitroofcoatings.com',
    icp: 'commercial roof coating contractor in Phoenix, Arizona',
    buyer: 'commercial property managers responsible for flat-roof maintenance budgets',
    locations: [{ label: 'phoenix', city: 'Phoenix', region: 'Arizona', country: 'US' }],
  },
  {
    slug: 'eval-local-multi-intent',
    displayName: 'Peak Comfort HVAC',
    domain: 'peakcomforthvac.com',
    icp: 'residential HVAC installation, repair, and maintenance company in Denver, Colorado',
    buyer: 'homeowners with aging furnaces or AC units comparing replacement and repair options',
    locations: [{ label: 'denver', city: 'Denver', region: 'Colorado', country: 'US' }],
  },
  {
    slug: 'eval-b2b-saas',
    displayName: 'QuoteBeam',
    domain: 'quotebeam.io',
    icp: 'quoting and proposal software for residential solar installers',
    buyer: 'solar sales managers evaluating quoting tools for a 10-50 rep team',
    locations: [],
  },
  {
    slug: 'eval-national-ecommerce',
    displayName: 'Willow and Sprout',
    domain: 'willowandsprout.com',
    icp: 'organic cotton baby clothing brand sold online across the US',
    buyer: 'expecting parents researching non-toxic baby essentials',
    locations: [],
  },
  {
    slug: 'eval-problem-heavy-consumer',
    displayName: 'SwiftRemit',
    domain: 'swiftremit.app',
    icp: 'mobile app for sending money internationally with low fees',
    buyer: 'immigrants who send money home to family every month',
    locations: [],
  },
]

export interface DiscoveryEvalScorecard {
  shape: string
  seedCountRaw: number
  /** True post-dedup canonical count (pre probe-budget truncation). */
  canonicalCount: number
  /** True when the engine predates canonical_count and the truncated seedCount
   *  had to stand in — comparisons against it understate quality. */
  canonicalCountTruncated: boolean
  retention: number
  /** Branded self-queries the filter dropped, as a share of ALL raw candidates
   *  (pre-filter denominator). The prompt rule should keep this at ~0. */
  brandShare: number
  /** Share of raw candidates contributed by grounding webSearchQueries. */
  groundingShare: number
  bandPairFraction: number | null
  probeCount: number
  warning: string | null
  durationSeconds: number | null
}

export interface DiscoveryEvalBaseline {
  capturedAt: string
  scorecards: DiscoveryEvalScorecard[]
}

export interface DiscoveryEvalVerdict {
  pass: boolean
  regressions: string[]
  notes: string[]
}

/** The platform's absolute canonical floor (checkDiscoverySession): an eval
 *  shape regressing below it means real paid runs would start dying. */
export const EVAL_CANONICAL_FLOOR = 8

/** Tolerance bands. Generous on purpose: each shape is one stochastic draw, so
 *  the bands absorb sampling noise while still catching real degradation. A
 *  failing metric near its band edge warrants a repeat run before concluding. */
export const EVAL_BANDS = {
  /** canonicalCount must be >= baseline * this factor (and >= the floor). */
  canonicalCountFactor: 0.6,
  /** retention may drop at most this many absolute points below baseline. */
  retentionDrop: 0.2,
  /** brandShare may exceed baseline by at most this (and never exceed 0.1). */
  brandShareSlack: 0.05,
  brandShareCeiling: 0.1,
  /** duration must be <= baseline * factor + slack seconds. */
  durationFactor: 2,
  durationSlackSeconds: 30,
} as const

export function scoreSession(shape: string, session: DiscoverySessionDto): DiscoveryEvalScorecard {
  const raw = session.seedCountRaw ?? 0
  const brandFiltered = session.seedBrandFilteredCount ?? 0
  const preFilterTotal = raw + brandFiltered
  const truncated = session.canonicalCount == null
  const canonicalCount = session.canonicalCount ?? session.seedCount ?? 0
  const started = session.startedAt ? Date.parse(session.startedAt) : NaN
  const finished = session.finishedAt ? Date.parse(session.finishedAt) : NaN
  return {
    shape,
    seedCountRaw: raw,
    canonicalCount,
    canonicalCountTruncated: truncated,
    retention: raw > 0 ? canonicalCount / raw : 0,
    brandShare: preFilterTotal > 0 ? brandFiltered / preFilterTotal : 0,
    groundingShare: raw > 0 ? (session.seedFromGroundingCount ?? 0) / raw : 0,
    bandPairFraction: session.dedupBandPairFraction ?? null,
    probeCount: session.probeCount ?? 0,
    warning: session.warning ?? null,
    durationSeconds:
      Number.isFinite(started) && Number.isFinite(finished) ? Math.round((finished - started) / 1000) : null,
  }
}

export function compareToBaseline(
  scorecards: readonly DiscoveryEvalScorecard[],
  baseline: DiscoveryEvalBaseline,
): DiscoveryEvalVerdict {
  const regressions: string[] = []
  const notes: string[] = []
  const bySlug = new Map(scorecards.map((c) => [c.shape, c]))

  for (const base of baseline.scorecards) {
    const current = bySlug.get(base.shape)
    if (!current) {
      regressions.push(`${base.shape}: missing from this run (baseline shape not evaluated)`)
      continue
    }
    bySlug.delete(base.shape)

    if (current.canonicalCount < EVAL_CANONICAL_FLOOR) {
      regressions.push(
        `${base.shape}: canonicalCount ${current.canonicalCount} is below the absolute platform floor (${EVAL_CANONICAL_FLOOR})`,
      )
    }
    if (current.canonicalCount < base.canonicalCount * EVAL_BANDS.canonicalCountFactor) {
      regressions.push(
        `${base.shape}: canonicalCount ${current.canonicalCount} vs baseline ${base.canonicalCount} (band: >= ${EVAL_BANDS.canonicalCountFactor}x)`,
      )
    }
    // Retention (canonicals / raw) only fails when canonicals ALSO regressed.
    // Retention is a within-config collapse signal; across configs whose raw
    // candidate volume differs (e.g. a single-provider baseline vs a
    // multi-provider variant that roughly doubles raw), retention drops purely
    // because the denominator grew even as distinct output rose. The canonical
    // count is the real quality signal, so retention only corroborates a
    // canonical regression, it never fails on its own.
    if (current.canonicalCount < base.canonicalCount && current.retention < base.retention - EVAL_BANDS.retentionDrop) {
      regressions.push(
        `${base.shape}: retention ${current.retention.toFixed(2)} vs baseline ${base.retention.toFixed(2)} (band: -${EVAL_BANDS.retentionDrop}), with canonicals also down (${current.canonicalCount} < ${base.canonicalCount})`,
      )
    }
    const brandCeiling = Math.min(base.brandShare + EVAL_BANDS.brandShareSlack, EVAL_BANDS.brandShareCeiling)
    if (current.brandShare > brandCeiling) {
      regressions.push(
        `${base.shape}: brandShare ${current.brandShare.toFixed(2)} exceeds ${brandCeiling.toFixed(2)} (no-brand rule regressed)`,
      )
    }
    if (current.warning) {
      regressions.push(`${base.shape}: collapse warning fired: ${current.warning.slice(0, 80)}`)
    }
    if (
      current.durationSeconds != null &&
      base.durationSeconds != null &&
      current.durationSeconds > base.durationSeconds * EVAL_BANDS.durationFactor + EVAL_BANDS.durationSlackSeconds
    ) {
      regressions.push(
        `${base.shape}: duration ${current.durationSeconds}s vs baseline ${base.durationSeconds}s (band: ${EVAL_BANDS.durationFactor}x + ${EVAL_BANDS.durationSlackSeconds}s)`,
      )
    }
    if (current.canonicalCountTruncated) {
      notes.push(`${base.shape}: engine predates canonical_count; using truncated seedCount (understates quality)`)
    }
  }

  for (const [slug] of bySlug) {
    notes.push(`${slug}: new shape with no baseline entry (add it via --update-baseline)`)
  }

  return { pass: regressions.length === 0, regressions, notes }
}
