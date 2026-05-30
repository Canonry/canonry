import { describe, expect, it } from 'vitest'
import { getTableColumns, getTableName, is, Table } from 'drizzle-orm'
import type { z } from 'zod'
import * as dbSchema from '@ainyc/canonry-db'
import {
  backlinkDomainDtoSchema,
  backlinkSummaryDtoSchema,
  bingConnectionDtoSchema,
  bingCoverageSnapshotDtoSchema,
  bingKeywordStatsDtoSchema,
  bingUrlInspectionDtoSchema,
  ccReleaseSyncDtoSchema,
  competitorDtoSchema,
  contentTargetDismissalDtoSchema,
  discoveryProbeDtoSchema,
  discoverySessionDtoSchema,
  ga4AiReferralDtoSchema,
  ga4ConnectionDtoSchema,
  ga4SocialReferralDtoSchema,
  ga4TrafficSnapshotDtoSchema,
  ga4TrafficSummaryDtoSchema,
  gbpLocationDtoSchema,
  gbpDailyMetricDtoSchema,
  gbpKeywordImpressionDtoSchema,
  gbpPlaceActionDtoSchema,
  gbpLodgingDtoSchema,
  gbpPlaceDetailsDtoSchema,
  googleConnectionDtoSchema,
  gscCoverageSnapshotDtoSchema,
  gscSearchDataDtoSchema,
  gscUrlInspectionDtoSchema,
  notificationDtoSchema,
  projectDtoSchema,
  queryDtoSchema,
  querySnapshotDtoSchema,
  recommendationExplanationDtoSchema,
  runDtoSchema,
  scheduleDtoSchema,
  trafficSourceDtoSchema,
} from '@ainyc/canonry-contracts'

/**
 * Dynamic DB ↔ DTO coverage check.
 *
 * Auto-discovers every `sqliteTable` exported from `@ainyc/canonry-db` and
 * requires each one to be classified in the `COVERAGE` map below:
 *
 *   - `kind: 'dto'`         → the table is exposed via a Zod DTO. The check
 *                             then asserts every DB column either appears on
 *                             the DTO's shape OR is listed in `internal`
 *                             with a one-line reason.
 *   - `kind: 'internal-only'` → the table is intentionally not exposed via
 *                               any public DTO (write-only audit trail,
 *                               auth secrets, internal aggregates, etc.).
 *                               No column check runs.
 *
 * Adding a new table → the "every table has a classification" assertion
 * fails until the author picks one of the two kinds. Adding a new column
 * to a `kind: 'dto'` table → the per-table column check fails until the
 * author either exposes it on the DTO (in `@ainyc/canonry-contracts`) or
 * lists it in `internal` with a justification.
 *
 * Why dynamic: the previous static version (#572) listed `{table, dto,
 * internal}` triples manually. A new table just-existed, never went into
 * the registry, and the test silently passed. The dynamic version starts
 * from "every table the schema exports" and forces a conscious decision.
 *
 * What this catches that other tests don't:
 *   - "Schema added a new table, nobody asked whether it should have a
 *      public DTO." → fails the classification check.
 *   - "Schema added a column to a covered table, nobody updated the DTO."
 *      → fails the per-table column check.
 *
 * What other tests cover:
 *   - `db-derived-dtos.test.ts` — the drizzle-zod derived schemas' field
 *     sets must equal the table's columns (catches the same drift but
 *     only for the migrated tables that have a derived schema).
 *   - TypeScript itself — formatX functions returning a DTO must list
 *     every field; an extra field not on the DTO is a type error.
 *
 * The three layers compose: TypeScript catches the formatX-vs-DTO drift,
 * `db-derived-dtos.test.ts` catches the schema-vs-derived drift for
 * migrated tables, this test catches the schema-vs-DTO drift for ALL
 * tables AND ensures every table is consciously classified.
 */

type CoverageEntry =
  | {
      kind: 'dto'
      dto: z.ZodObject<z.ZodRawShape>
      /** DB column property → one-line reason it's not on the DTO. */
      internal: Record<string, string>
    }
  | {
      kind: 'internal-only'
      /** One-line reason this table has no public DTO surface. */
      reason: string
    }

const COVERAGE: Record<string, CoverageEntry> = {
  // ─── Tables with a public DTO ──────────────────────────────────────────
  projects: {
    kind: 'dto',
    dto: projectDtoSchema,
    internal: {
      icpDescription: 'Aero analyst context; not exposed on the public project DTO.',
    },
  },
  queries: {
    kind: 'dto',
    dto: queryDtoSchema,
    internal: {
      projectId: 'Implied by the route scope (/projects/:name/queries).',
      provenance: 'Discovery provenance tag; internal bookkeeping.',
    },
  },
  competitors: {
    kind: 'dto',
    dto: competitorDtoSchema,
    internal: {
      projectId: 'Implied by the route scope (/projects/:name/competitors).',
      provenance: 'Discovery provenance tag; internal bookkeeping.',
    },
  },
  runs: {
    kind: 'dto',
    dto: runDtoSchema,
    internal: {
      sourceId: 'Set for traffic-sync runs; consumed by traffic routes, not the user-facing run DTO.',
    },
  },
  querySnapshots: {
    kind: 'dto',
    dto: querySnapshotDtoSchema,
    internal: {
      queryText: 'Renamed to `query` on the DTO (self-describing when queries row is deleted).',
      screenshotPath: 'Debug-only artifact path; not surfaced on the snapshot DTO.',
      rawResponse: 'Raw provider payload; exposed via a separate endpoint, not the snapshot DTO.',
    },
  },
  schedules: {
    kind: 'dto',
    dto: scheduleDtoSchema,
    internal: {},
  },
  notifications: {
    kind: 'dto',
    dto: notificationDtoSchema,
    internal: {
      config: 'JSON column; expanded into url/events/source/etc by formatNotification.',
    },
  },
  googleConnections: {
    kind: 'dto',
    dto: googleConnectionDtoSchema,
    internal: {
      createdByProjectId: 'Ownership marker for cross-project takeover defense; enforced by the OAuth callback and DELETE route, not exposed on the public DTO.',
    },
  },
  gbpLocations: {
    kind: 'dto',
    dto: gbpLocationDtoSchema,
    internal: {},
  },
  gbpDailyMetrics: {
    kind: 'dto',
    dto: gbpDailyMetricDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
    },
  },
  gbpKeywordImpressions: {
    kind: 'dto',
    dto: gbpKeywordImpressionDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
    },
  },
  gbpKeywordMonthly: {
    kind: 'internal-only',
    reason: 'Accumulating per-month keyword series; an internal trend-history aggregate consumed by the intelligence engine (month-over-month keyword-drop insights), not exposed as its own DTO. The current snapshot is served by gbpKeywordImpressions.',
  },
  gbpPlaceDetails: {
    kind: 'dto',
    dto: gbpPlaceDetailsDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      contentHash: 'Snapshot-on-change dedupe key; internal.',
      syncRunId: 'Internal join key.',
      attributes: 'Exposed as `place` on the DTO (with the derived `amenities` list alongside).',
    },
  },
  gbpPlaceActions: {
    kind: 'dto',
    dto: gbpPlaceActionDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
    },
  },
  gbpLodgingSnapshots: {
    kind: 'dto',
    dto: gbpLodgingDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
      contentHash: 'Snapshot-on-change dedupe key; internal.',
    },
  },
  gscSearchData: {
    kind: 'dto',
    dto: gscSearchDataDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
      createdAt: 'Row creation timestamp.',
    },
  },
  gscUrlInspections: {
    kind: 'dto',
    dto: gscUrlInspectionDtoSchema,
    internal: {
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
      createdAt: 'Row creation timestamp.',
    },
  },
  gscCoverageSnapshots: {
    kind: 'dto',
    dto: gscCoverageSnapshotDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
      createdAt: 'Row creation timestamp.',
    },
  },
  bingConnections: {
    kind: 'dto',
    dto: bingConnectionDtoSchema,
    internal: {
      createdByProjectId: 'Ownership marker for cross-project takeover defense; enforced by the connect / disconnect routes, not exposed on the public DTO.',
    },
  },
  bingCoverageSnapshots: {
    kind: 'dto',
    dto: bingCoverageSnapshotDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
      createdAt: 'Row creation timestamp.',
    },
  },
  bingUrlInspections: {
    kind: 'dto',
    dto: bingUrlInspectionDtoSchema,
    internal: {
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
      createdAt: 'Row creation timestamp.',
    },
  },
  bingKeywordStats: {
    kind: 'dto',
    dto: bingKeywordStatsDtoSchema,
    internal: {
      id: 'Surrogate key; keyword stats are addressed by (project, query).',
      projectId: 'Implied by the route scope.',
      syncedAt: 'Internal sync timestamp.',
      createdAt: 'Row creation timestamp.',
    },
  },
  gaConnections: {
    kind: 'dto',
    dto: ga4ConnectionDtoSchema,
    internal: {},
  },
  gaTrafficSnapshots: {
    kind: 'dto',
    dto: ga4TrafficSnapshotDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      landingPageNormalized: 'Internal normalization key for per-page joins; the DTO exposes the human landingPage.',
      directSessions: 'Per-page direct sessions; surfaced on the summary DTO, not the per-page snapshot DTO.',
      syncedAt: 'Internal sync timestamp.',
      syncRunId: 'Internal join key.',
    },
  },
  gaAiReferrals: {
    kind: 'dto',
    dto: ga4AiReferralDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      date: 'Aggregated away in the (source, medium) DTO.',
      channelGroup: 'Internal classification; the DTO exposes the source/medium/sourceDimension lens.',
      landingPage: 'Surfaced on the landing-page-aware DTO, not the (source, medium) aggregate DTO.',
      landingPageNormalized: 'Internal join key; see landingPage.',
      syncedAt: 'Internal sync timestamp.',
      syncRunId: 'Internal join key.',
    },
  },
  gaSocialReferrals: {
    kind: 'dto',
    dto: ga4SocialReferralDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      date: 'Aggregated away in the (source, medium, channelGroup) DTO.',
      syncedAt: 'Internal sync timestamp.',
      syncRunId: 'Internal join key.',
    },
  },
  gaTrafficSummaries: {
    kind: 'dto',
    dto: ga4TrafficSummaryDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      periodStart: 'Implied by the request window.',
      periodEnd: 'Implied by the request window.',
      syncedAt: 'Internal sync timestamp.',
      syncRunId: 'Internal join key.',
    },
  },
  discoverySessions: {
    kind: 'dto',
    dto: discoverySessionDtoSchema,
    internal: {
      runId: 'Internal join key; the session DTO surfaces status/probes instead.',
    },
  },
  discoveryProbes: {
    kind: 'dto',
    dto: discoveryProbeDtoSchema,
    internal: {
      rawResponse: 'Raw provider payload; internal debugging artifact.',
    },
  },
  backlinkDomains: {
    kind: 'dto',
    dto: backlinkDomainDtoSchema,
    internal: {
      id: 'Surrogate key; backlink domain rows are addressed by linkingDomain.',
      projectId: 'Implied by the route scope (/projects/:name/backlinks).',
      releaseSyncId: 'Internal join key; the public surface references the release string.',
      release: 'Surfaced on the parent response wrapper, not per row.',
      targetDomain: 'Surfaced on the parent summary, not per row.',
      createdAt: 'Row creation timestamp; the public surface uses queriedAt on the summary.',
    },
  },
  backlinkSummaries: {
    kind: 'dto',
    dto: backlinkSummaryDtoSchema,
    internal: {
      id: 'Surrogate key.',
      releaseSyncId: 'Internal join key; the public surface references the release string.',
      createdAt: 'Row creation timestamp; the public surface uses queriedAt.',
    },
  },
  ccReleaseSyncs: {
    kind: 'dto',
    dto: ccReleaseSyncDtoSchema,
    internal: {},
  },
  contentTargetDismissals: {
    kind: 'dto',
    dto: contentTargetDismissalDtoSchema,
    internal: {
      id: 'Surrogate key; dismissals are addressed by (projectId, targetRef).',
      projectId: 'Implied by the route scope (/projects/:name/content/dismissals).',
    },
  },
  recommendationExplanations: {
    kind: 'dto',
    dto: recommendationExplanationDtoSchema,
    internal: {
      id: 'Surrogate key; explanations are addressed by (projectId, targetRef, promptVersion).',
      projectId: 'Implied by the route scope (/projects/:name/content/recommendations/:targetRef/analyze).',
    },
  },
  trafficSources: {
    kind: 'dto',
    dto: trafficSourceDtoSchema,
    internal: {
      lastEventIds: 'Bounded ring buffer of recent event IDs; internal dedup state, not part of the source DTO.',
      configJson: 'Exposed on the DTO as `config`; the DB column keeps the `Json` suffix for grep-ability.',
    },
  },

  // ─── Tables intentionally without a public DTO ────────────────────────
  // Add to this set when you create a table that has no consumer-facing
  // shape — write-only audit rows, auth secrets, internal aggregates,
  // hot-path rollups consumed via composite endpoints, etc.
  auditLog: {
    kind: 'internal-only',
    reason: 'Write-only audit trail; queried via composite endpoints, not directly mapped to a DTO.',
  },
  apiKeys: {
    kind: 'internal-only',
    reason: 'Auth credentials; only the prefix is ever returned via the dedicated key-management surface.',
  },
  usageCounters: {
    kind: 'internal-only',
    reason: 'Internal rate-limit / quota counters; never exposed.',
  },
  agentSessions: {
    kind: 'internal-only',
    reason: 'Aero session state (transcript + queue). Exposed via the agent transcript composite, not as a direct row DTO.',
  },
  agentMemory: {
    kind: 'internal-only',
    reason: 'Aero durable notes. Surfaced via AgentMemoryEntryDto (TS interface only — not a Zod schema, so out of scope for this DTO-shape check).',
  },
  insights: {
    kind: 'internal-only',
    reason: 'Surfaced via InsightDto (TS interface only — not a Zod schema, so out of scope for this DTO-shape check).',
  },
  healthSnapshots: {
    kind: 'internal-only',
    reason: 'Surfaced via HealthSnapshotDto (TS interface only — not a Zod schema, so out of scope for this DTO-shape check).',
  },
  gaTrafficWindowSummaries: {
    kind: 'internal-only',
    reason: 'Per-window aggregate totals consumed by the GA traffic composite endpoints, not a direct DTO.',
  },
  crawlerEventsHourly: {
    kind: 'internal-only',
    reason: 'Hourly rollup consumed via /traffic/events composite, not directly mapped to a DTO.',
  },
  aiUserFetchEventsHourly: {
    kind: 'internal-only',
    reason: 'Hourly rollup consumed via /traffic/events composite, not directly mapped to a DTO.',
  },
  aiReferralEventsHourly: {
    kind: 'internal-only',
    reason: 'Hourly rollup consumed via /traffic/events composite, not directly mapped to a DTO.',
  },
  rawEventSamples: {
    kind: 'internal-only',
    reason: 'Short-retention raw evidence for classifier debugging; not part of the public API.',
  },
  migrationsTable: {
    kind: 'internal-only',
    reason: 'Internal migration bookkeeping; never exposed.',
  },
  cloudMetadata: {
    kind: 'internal-only',
    reason: 'Tenant bootstrap singleton (Track 3 Canonry Hosted); read by cloud-bridge / doctor only, never on the public DTO surface.',
  },
  providerTokenUsage: {
    kind: 'internal-only',
    reason: 'Per-(run, provider, model) token-cost telemetry (Track 1 Canonry Hosted); consumed by the cloud control plane for billing, not exposed on a public DTO yet.',
  },
  users: {
    kind: 'internal-only',
    reason: 'Identity record bound to an api_keys row; the auth/session surface returns booleans + projectName, not the user row itself.',
  },
  guestReports: {
    kind: 'internal-only',
    reason: 'Anonymous /aero guest-report state; the guest-report endpoints expose a hand-shaped GuestReportDto rather than the raw row.',
  },
  appSettings: {
    kind: 'internal-only',
    reason: 'Generic instance-wide key/value store (e.g. dashboard password hash for apps/api); deliberately never exposed via a DTO.',
  },
}

interface DiscoveredTable {
  prop: string
  dbName: string
  table: Parameters<typeof getTableColumns>[0]
}

const ALL_TABLES: DiscoveredTable[] = Object.entries(dbSchema)
  .filter(([, v]) => is(v as unknown, Table))
  .map(([prop, v]) => ({
    prop,
    dbName: getTableName(v as Parameters<typeof getTableName>[0]),
    table: v as Parameters<typeof getTableColumns>[0],
  }))

describe('DB ↔ DTO coverage (dynamic)', () => {
  describe('every sqliteTable is classified in COVERAGE', () => {
    for (const t of ALL_TABLES) {
      it(`${t.prop} (${t.dbName}) has a coverage entry`, () => {
        const entry = COVERAGE[t.prop]
        expect(
          entry,
          `Table \`${t.prop}\` (sql: \`${t.dbName}\`) has no entry in packages/api-routes/test/db-dto-coverage.test.ts COVERAGE.\n\n` +
            `Add one of:\n` +
            `  ${t.prop}: { kind: 'dto', dto: <yourDtoSchema>, internal: { /* col: 'reason' */ } }\n` +
            `OR\n` +
            `  ${t.prop}: { kind: 'internal-only', reason: 'why this table has no public DTO' }`,
        ).toBeDefined()
      })
    }
  })

  describe('every dto-classified table covers all DB columns', () => {
    for (const t of ALL_TABLES) {
      const entry = COVERAGE[t.prop]
      if (!entry || entry.kind !== 'dto') continue

      it(`${t.prop}: every column is on the DTO or in internal`, () => {
        const dbColumns = Object.keys(getTableColumns(t.table))
        const dtoFields = Object.keys(entry.dto.shape)
        const internalCols = Object.keys(entry.internal)

        const orphaned = dbColumns.filter(
          (col) => !dtoFields.includes(col) && !internalCols.includes(col),
        )

        if (orphaned.length > 0) {
          const hint = orphaned
            .map((col) => `    - ${col}: add to the DTO in packages/contracts/ OR list in COVERAGE.${t.prop}.internal with a reason`)
            .join('\n')
          throw new Error(
            `Table \`${t.prop}\` has columns not exposed on its DTO and not marked internal:\n${hint}`,
          )
        }
        expect(orphaned).toEqual([])
      })

      it(`${t.prop}: internal allowlist references only real DB columns`, () => {
        const dbColumns = new Set(Object.keys(getTableColumns(t.table)))
        const stale = Object.keys(entry.internal).filter((col) => !dbColumns.has(col))
        expect(
          stale,
          `Stale entries in COVERAGE.${t.prop}.internal — these columns no longer exist on the table: ${stale.join(', ')}`,
        ).toEqual([])
      })
    }
  })

  it('COVERAGE has no stale entries (every key refers to a real table)', () => {
    const tableProps = new Set(ALL_TABLES.map((t) => t.prop))
    const stale = Object.keys(COVERAGE).filter((prop) => !tableProps.has(prop))
    expect(
      stale,
      `COVERAGE has entries for tables that no longer exist in the schema: ${stale.join(', ')}`,
    ).toEqual([])
  })
})
