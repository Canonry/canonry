import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { z } from 'zod'
import {
  backlinkDomains,
  backlinkSummaries,
  bingConnections,
  bingCoverageSnapshots,
  bingKeywordStats,
  bingUrlInspections,
  ccReleaseSyncs,
  competitors,
  discoveryProbes,
  discoverySessions,
  gaAiReferrals,
  gaConnections,
  gaSocialReferrals,
  gaTrafficSnapshots,
  gaTrafficSummaries,
  googleConnections,
  gscCoverageSnapshots,
  gscSearchData,
  gscUrlInspections,
  notifications,
  projects,
  queries,
  querySnapshots,
  runs,
  schedules,
} from '@ainyc/canonry-db'
import {
  backlinkDomainDtoSchema,
  backlinkSummaryDtoSchema,
  bingConnectionDtoSchema,
  bingCoverageSnapshotDtoSchema,
  bingKeywordStatsDtoSchema,
  bingUrlInspectionDtoSchema,
  ccReleaseSyncDtoSchema,
  competitorDtoSchema,
  discoveryProbeDtoSchema,
  discoverySessionDtoSchema,
  ga4AiReferralDtoSchema,
  ga4ConnectionDtoSchema,
  ga4SocialReferralDtoSchema,
  ga4TrafficSnapshotDtoSchema,
  ga4TrafficSummaryDtoSchema,
  googleConnectionDtoSchema,
  gscCoverageSnapshotDtoSchema,
  gscSearchDataDtoSchema,
  gscUrlInspectionDtoSchema,
  notificationDtoSchema,
  projectDtoSchema,
  queryDtoSchema,
  querySnapshotDtoSchema,
  runDtoSchema,
  scheduleDtoSchema,
} from '@ainyc/canonry-contracts'

/**
 * DB ↔ DTO coverage map.
 *
 * For every DB table that has a corresponding public DTO, the entry below
 * lists the table, the DTO schema, and an `internal` allowlist mapping
 * columns intentionally NOT present on the DTO to a one-line reason. The
 * test asserts every column in the DB table is either in the DTO's shape
 * or in `internal` — so adding a new column to a covered table forces the
 * author to either expose it in the DTO or document why it's internal.
 *
 * What this catches: a column added to the DB and quietly returned by a
 * route (or `formatX` bridge) but missing from the Zod DTO it claims to
 * conform to. Concretely, this would have caught the `projects.providers`
 * drift fixed earlier — the column was emitted by GET /projects/:name for
 * the whole life of the codebase, but the DTO schema didn't list it, so
 * the generated SDK gave web/CLI consumers `Record<string, unknown>` on
 * that field.
 *
 * Why DB → DTO (not the inverse): DTOs can compose data from multiple
 * tables, derive fields, or have computed values (e.g. snapshot
 * `mentionState` derived from `answerMentioned`). The drift hazard is one
 * direction: a column added to the DB that the DTO doesn't acknowledge.
 *
 * Out of scope (intentionally not covered):
 * - Tables with no Zod-schema DTO (only TS-interface DTOs) like
 *   `insights` (InsightDto) and `healthSnapshots` (HealthSnapshotDto) —
 *   they have no `.shape` to introspect. Migrating those to Zod is a
 *   follow-up that would extend this test.
 * - Pure-internal tables: `auditLog`, `apiKeys`, `agentSessions`,
 *   `agentMemory`, `usageCounters`, `migrationsTable`, hourly traffic
 *   rollups (`crawlerEventsHourly`, `aiReferralEventsHourly`),
 *   `rawEventSamples`. No DTO maps 1:1 to these.
 */

interface CoverageEntry {
  table: SQLiteTable
  dto: z.ZodObject<z.ZodRawShape>
  /** DB column property name → one-line reason it's not on the DTO. */
  internal: Record<string, string>
}

const COVERAGE: Record<string, CoverageEntry> = {
  projects: {
    table: projects,
    dto: projectDtoSchema,
    internal: {
      icpDescription: 'Aero analyst context; not exposed on the public project DTO.',
    },
  },
  runs: {
    table: runs,
    dto: runDtoSchema,
    internal: {
      sourceId: 'Set for traffic-sync runs; consumed by traffic routes, not part of the user-facing run DTO.',
    },
  },
  schedules: {
    table: schedules,
    dto: scheduleDtoSchema,
    internal: {},
  },
  notifications: {
    table: notifications,
    dto: notificationDtoSchema,
    internal: {
      config: 'JSON column; expanded into url/events/source/etc by formatNotification.',
    },
  },
  querySnapshots: {
    table: querySnapshots,
    dto: querySnapshotDtoSchema,
    internal: {
      queryText: 'Renamed to `query` on the DTO (snapshot is self-describing when queries row is deleted).',
      screenshotPath: 'Debug-only artifact path; not surfaced on the snapshot DTO.',
      rawResponse: 'Raw provider payload; exposed via a separate endpoint, not the snapshot DTO.',
    },
  },
  queries: {
    table: queries,
    dto: queryDtoSchema,
    internal: {
      projectId: 'Implied by the route scope (/projects/:name/queries).',
      provenance: 'Discovery provenance tag; internal bookkeeping.',
    },
  },
  competitors: {
    table: competitors,
    dto: competitorDtoSchema,
    internal: {
      projectId: 'Implied by the route scope (/projects/:name/competitors).',
      provenance: 'Discovery provenance tag; internal bookkeeping.',
    },
  },
  discoverySessions: {
    table: discoverySessions,
    dto: discoverySessionDtoSchema,
    internal: {
      runId: 'Internal join key; the session DTO surfaces status/probes instead.',
    },
  },
  discoveryProbes: {
    table: discoveryProbes,
    dto: discoveryProbeDtoSchema,
    internal: {
      rawResponse: 'Raw provider payload; internal debugging artifact.',
    },
  },
  backlinkDomains: {
    table: backlinkDomains,
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
    table: backlinkSummaries,
    dto: backlinkSummaryDtoSchema,
    internal: {
      id: 'Surrogate key.',
      releaseSyncId: 'Internal join key; the public surface references the release string.',
      createdAt: 'Row creation timestamp; the public surface uses queriedAt.',
    },
  },
  ccReleaseSyncs: {
    table: ccReleaseSyncs,
    dto: ccReleaseSyncDtoSchema,
    internal: {},
  },
  googleConnections: {
    table: googleConnections,
    dto: googleConnectionDtoSchema,
    internal: {},
  },
  bingConnections: {
    table: bingConnections,
    dto: bingConnectionDtoSchema,
    internal: {},
  },
  bingKeywordStats: {
    table: bingKeywordStats,
    dto: bingKeywordStatsDtoSchema,
    internal: {
      id: 'Surrogate key; keyword stats are addressed by (project, query).',
      projectId: 'Implied by the route scope.',
      syncedAt: 'Internal sync timestamp.',
      createdAt: 'Row creation timestamp.',
    },
  },
  bingUrlInspections: {
    table: bingUrlInspections,
    dto: bingUrlInspectionDtoSchema,
    internal: {
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
      createdAt: 'Row creation timestamp.',
    },
  },
  bingCoverageSnapshots: {
    table: bingCoverageSnapshots,
    dto: bingCoverageSnapshotDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
      createdAt: 'Row creation timestamp.',
    },
  },
  gaConnections: {
    table: gaConnections,
    dto: ga4ConnectionDtoSchema,
    internal: {
      // `connected` lives on the DTO but not the row — it's derived. No
      // DB column is hidden from the DTO for this table.
    },
  },
  gaTrafficSnapshots: {
    table: gaTrafficSnapshots,
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
    table: gaAiReferrals,
    dto: ga4AiReferralDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      date: 'Aggregated away in the (source, medium) DTO.',
      channelGroup: 'Internal classification; the DTO exposes the source/medium/sourceDimension lens.',
      landingPage: 'Surfaced on the landing-page-aware DTO (ga4AiReferralLandingPageDtoSchema), not the (source, medium) aggregate DTO.',
      landingPageNormalized: 'Internal join key; see landingPage.',
      syncedAt: 'Internal sync timestamp.',
      syncRunId: 'Internal join key.',
    },
  },
  gaSocialReferrals: {
    table: gaSocialReferrals,
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
    table: gaTrafficSummaries,
    dto: ga4TrafficSummaryDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      periodStart: 'Implied by the request window.',
      periodEnd: 'Implied by the request window.',
      syncedAt: 'Internal sync timestamp.',
      syncRunId: 'Internal join key.',
      // The summary DTO carries totalSessions / totalOrganicSessions /
      // totalDirectSessions / totalUsers + topPages. topPages is derived
      // from per-page snapshots, not stored on this row.
    },
  },
  gscSearchData: {
    table: gscSearchData,
    dto: gscSearchDataDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
      createdAt: 'Row creation timestamp.',
    },
  },
  gscUrlInspections: {
    table: gscUrlInspections,
    dto: gscUrlInspectionDtoSchema,
    internal: {
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
      createdAt: 'Row creation timestamp.',
    },
  },
  gscCoverageSnapshots: {
    table: gscCoverageSnapshots,
    dto: gscCoverageSnapshotDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
      createdAt: 'Row creation timestamp.',
    },
  },
}

describe('DB ↔ DTO coverage', () => {
  for (const [name, entry] of Object.entries(COVERAGE)) {
    it(`every column in ${name} is exposed on its DTO or marked internal`, () => {
      const dbColumns = Object.keys(getTableColumns(entry.table))
      const dtoFields = Object.keys(entry.dto.shape)
      const internalCols = Object.keys(entry.internal)

      const orphaned = dbColumns.filter(
        (col) => !dtoFields.includes(col) && !internalCols.includes(col),
      )

      if (orphaned.length > 0) {
        const dtoName = entry.dto.description ?? `${name}DtoSchema`
        const hint = orphaned
          .map((col) => `    - ${col}: add to ${dtoName} OR list in COVERAGE.${name}.internal with a reason`)
          .join('\n')
        throw new Error(
          `Table \`${name}\` has columns not exposed on its DTO and not marked internal:\n${hint}\n\n` +
            `If the column should be returned to users: add it to ${dtoName} in packages/contracts/src/.\n` +
            `If the column is internal-only: list it in packages/api-routes/test/db-dto-coverage.test.ts\n` +
            `under COVERAGE.${name}.internal with a one-line reason.`,
        )
      }

      expect(orphaned).toEqual([])
    })

    it(`every entry in COVERAGE.${name}.internal references a real DB column`, () => {
      const dbColumns = new Set(Object.keys(getTableColumns(entry.table)))
      const stale = Object.keys(entry.internal).filter((col) => !dbColumns.has(col))
      expect(stale, `Stale entries in COVERAGE.${name}.internal — these columns no longer exist on the table: ${stale.join(', ')}`).toEqual([])
    })
  }
})
