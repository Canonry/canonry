import { describe, expect, it } from 'vitest'
import { getTableColumns, is } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { z } from 'zod'
import * as db from '@ainyc/canonry-db'
import * as contracts from '@ainyc/canonry-contracts'

/**
 * DB ↔ DTO coverage map (dynamic).
 *
 * Discovery rules:
 *   1. Every exported `SQLiteTable` from `@ainyc/canonry-db` is automatically
 *      checked unless listed in `TABLES_WITHOUT_DTOS`.
 *   2. The matching DTO is looked up by name in `@ainyc/canonry-contracts`:
 *        a. `<table>DtoSchema` (handles `bingKeywordStats`, `gscSearchData`…)
 *        b. `<table-without-trailing-s>DtoSchema` (handles `projects`, `runs`…)
 *        c. `<table-ies+y>DtoSchema` (handles `backlinkSummaries`…)
 *        d. `DTO_NAME_OVERRIDES[table]` for irregular names (e.g.
 *           `gaConnections` → `ga4ConnectionDtoSchema`).
 *   3. Per-table columns intentionally NOT on the DTO go in
 *      `INTERNAL_COLUMNS`, each with a one-line reason.
 *
 * What this catches: a column added to the DB and quietly returned by a
 * route (or `formatX` bridge) but missing from the Zod DTO it claims to
 * conform to. Concretely, this catches the `projects.providers` drift
 * fixed earlier — and would have caught it years sooner had it existed.
 *
 * Adding a new table requires *one* of: a matching DTO export, a
 * `DTO_NAME_OVERRIDES` entry, or a `TABLES_WITHOUT_DTOS` entry. Adding a
 * new column to an existing table requires adding it to the DTO or
 * listing it in `INTERNAL_COLUMNS` with a reason. CI fails until then.
 *
 * Why DB → DTO (not the inverse): DTOs can compose data from multiple
 * tables, derive fields, or have computed values (e.g. snapshot
 * `mentionState` derived from `answerMentioned`). The drift hazard runs
 * one direction: a column added to the DB that the DTO doesn't acknowledge.
 */

// Tables intentionally without a public DTO. Each entry must explain why.
const TABLES_WITHOUT_DTOS: Record<string, string> = {
  agentMemory: 'Agent runtime bookkeeping; not user-facing.',
  agentSessions: 'Agent runtime bookkeeping; not user-facing.',
  aiReferralEventsHourly: 'Hourly traffic rollup; consumed via aggregate DTOs only.',
  apiKeys: 'Credential storage; never returned.',
  auditLog: 'Internal audit trail.',
  crawlerEventsHourly: 'Hourly traffic rollup; consumed via aggregate DTOs only.',
  gaTrafficWindowSummaries: 'Internal window-aggregation cache; surfaced via gaTrafficSummary DTO.',
  healthSnapshots: 'DTO is a TS interface (HealthSnapshotDto), not a Zod schema — no `.shape` to introspect. Migration to Zod is a follow-up.',
  insights: 'DTO is a TS interface (InsightDto), not a Zod schema. Migration to Zod is a follow-up.',
  migrationsTable: 'DB migration runner state.',
  rawEventSamples: 'Raw debug events; never user-facing.',
  trafficSources: 'Internal traffic-source registry; surfaced via the trafficSource DTO from a separate route, not by direct table mapping. TODO: align and remove from this list (see PR #572 review).',
  usageCounters: 'Internal billing counters.',
}

// Tables whose DTO export name doesn't follow the inferred conventions.
const DTO_NAME_OVERRIDES: Record<string, string> = {
  gaConnections: 'ga4ConnectionDtoSchema',
  gaTrafficSnapshots: 'ga4TrafficSnapshotDtoSchema',
  gaAiReferrals: 'ga4AiReferralDtoSchema',
  gaSocialReferrals: 'ga4SocialReferralDtoSchema',
  gaTrafficSummaries: 'ga4TrafficSummaryDtoSchema',
}

// Per-table internal columns: present on the DB but intentionally not on
// the DTO. Each entry must have a one-line reason.
const INTERNAL_COLUMNS: Record<string, Record<string, string>> = {
  projects: {
    icpDescription: 'Aero analyst context; not exposed on the public project DTO.',
  },
  runs: {
    sourceId: 'Set for traffic-sync runs; consumed by traffic routes, not part of the user-facing run DTO.',
  },
  notifications: {
    config: 'JSON column; expanded into url/events/source/etc by formatNotification.',
  },
  querySnapshots: {
    queryText: 'Renamed to `query` on the DTO (snapshot is self-describing when queries row is deleted).',
    screenshotPath: 'Debug-only artifact path; not surfaced on the snapshot DTO.',
    rawResponse: 'Raw provider payload; exposed via a separate endpoint, not the snapshot DTO.',
  },
  queries: {
    projectId: 'Implied by the route scope (/projects/:name/queries).',
    provenance: 'Discovery provenance tag; internal bookkeeping.',
  },
  competitors: {
    projectId: 'Implied by the route scope (/projects/:name/competitors).',
    provenance: 'Discovery provenance tag; internal bookkeeping.',
  },
  discoverySessions: {
    runId: 'Internal join key; the session DTO surfaces status/probes instead.',
  },
  discoveryProbes: {
    rawResponse: 'Raw provider payload; internal debugging artifact.',
  },
  backlinkDomains: {
    id: 'Surrogate key; backlink domain rows are addressed by linkingDomain.',
    projectId: 'Implied by the route scope (/projects/:name/backlinks).',
    releaseSyncId: 'Internal join key; the public surface references the release string.',
    release: 'Surfaced on the parent response wrapper, not per row.',
    targetDomain: 'Surfaced on the parent summary, not per row.',
    createdAt: 'Row creation timestamp; the public surface uses queriedAt on the summary.',
  },
  backlinkSummaries: {
    id: 'Surrogate key.',
    releaseSyncId: 'Internal join key; the public surface references the release string.',
    createdAt: 'Row creation timestamp; the public surface uses queriedAt.',
  },
  bingKeywordStats: {
    id: 'Surrogate key; keyword stats are addressed by (project, query).',
    projectId: 'Implied by the route scope.',
    syncedAt: 'Internal sync timestamp.',
    createdAt: 'Row creation timestamp.',
  },
  bingUrlInspections: {
    projectId: 'Implied by the route scope.',
    syncRunId: 'Internal join key.',
    createdAt: 'Row creation timestamp.',
  },
  bingCoverageSnapshots: {
    id: 'Surrogate key.',
    projectId: 'Implied by the route scope.',
    syncRunId: 'Internal join key.',
    createdAt: 'Row creation timestamp.',
  },
  gaTrafficSnapshots: {
    id: 'Surrogate key.',
    projectId: 'Implied by the route scope.',
    landingPageNormalized: 'Internal normalization key for per-page joins; the DTO exposes the human landingPage.',
    directSessions: 'Per-page direct sessions; surfaced on the summary DTO, not the per-page snapshot DTO.',
    syncedAt: 'Internal sync timestamp.',
    syncRunId: 'Internal join key.',
  },
  gaAiReferrals: {
    id: 'Surrogate key.',
    projectId: 'Implied by the route scope.',
    date: 'Aggregated away in the (source, medium) DTO.',
    channelGroup: 'Internal classification; the DTO exposes the source/medium/sourceDimension lens.',
    landingPage: 'Surfaced on the landing-page-aware DTO (ga4AiReferralLandingPageDtoSchema), not the (source, medium) aggregate DTO.',
    landingPageNormalized: 'Internal join key; see landingPage.',
    syncedAt: 'Internal sync timestamp.',
    syncRunId: 'Internal join key.',
  },
  gaSocialReferrals: {
    id: 'Surrogate key.',
    projectId: 'Implied by the route scope.',
    date: 'Aggregated away in the (source, medium, channelGroup) DTO.',
    syncedAt: 'Internal sync timestamp.',
    syncRunId: 'Internal join key.',
  },
  gaTrafficSummaries: {
    id: 'Surrogate key.',
    projectId: 'Implied by the route scope.',
    periodStart: 'Implied by the request window.',
    periodEnd: 'Implied by the request window.',
    syncedAt: 'Internal sync timestamp.',
    syncRunId: 'Internal join key.',
  },
  gscSearchData: {
    id: 'Surrogate key.',
    projectId: 'Implied by the route scope.',
    syncRunId: 'Internal join key.',
    createdAt: 'Row creation timestamp.',
  },
  gscUrlInspections: {
    projectId: 'Implied by the route scope.',
    syncRunId: 'Internal join key.',
    createdAt: 'Row creation timestamp.',
  },
  gscCoverageSnapshots: {
    id: 'Surrogate key.',
    projectId: 'Implied by the route scope.',
    syncRunId: 'Internal join key.',
    createdAt: 'Row creation timestamp.',
  },
}

function findDto(tableName: string): z.ZodObject<z.ZodRawShape> | undefined {
  const exports = contracts as Record<string, unknown>
  if (DTO_NAME_OVERRIDES[tableName]) {
    return exports[DTO_NAME_OVERRIDES[tableName]] as z.ZodObject<z.ZodRawShape> | undefined
  }
  const candidates: string[] = [`${tableName}DtoSchema`]
  if (tableName.endsWith('ies')) candidates.push(`${tableName.slice(0, -3)}yDtoSchema`)
  if (tableName.endsWith('s')) candidates.push(`${tableName.slice(0, -1)}DtoSchema`)
  for (const candidate of candidates) {
    const dto = exports[candidate]
    if (dto) return dto as z.ZodObject<z.ZodRawShape>
  }
  return undefined
}

const allTables = (Object.entries(db) as Array<[string, unknown]>)
  .filter((entry): entry is [string, SQLiteTable] => is(entry[1], SQLiteTable))
  .sort(([a], [b]) => a.localeCompare(b))

describe('DB ↔ DTO coverage', () => {
  it('TABLES_WITHOUT_DTOS only references real tables', () => {
    const real = new Set(allTables.map(([n]) => n))
    const stale = Object.keys(TABLES_WITHOUT_DTOS).filter((n) => !real.has(n))
    expect(stale, `Stale entries in TABLES_WITHOUT_DTOS: ${stale.join(', ')}`).toEqual([])
  })

  it('DTO_NAME_OVERRIDES only references real tables', () => {
    const real = new Set(allTables.map(([n]) => n))
    const stale = Object.keys(DTO_NAME_OVERRIDES).filter((n) => !real.has(n))
    expect(stale, `Stale entries in DTO_NAME_OVERRIDES: ${stale.join(', ')}`).toEqual([])
  })

  it('INTERNAL_COLUMNS only references real tables', () => {
    const real = new Set(allTables.map(([n]) => n))
    const stale = Object.keys(INTERNAL_COLUMNS).filter((n) => !real.has(n))
    expect(stale, `Stale entries in INTERNAL_COLUMNS: ${stale.join(', ')}`).toEqual([])
  })

  for (const [name, table] of allTables) {
    if (TABLES_WITHOUT_DTOS[name]) continue
    const dto = findDto(name)

    it(`${name} has a discoverable DTO`, () => {
      if (dto) return
      const singular = name.endsWith('ies')
        ? `${name.slice(0, -3)}y`
        : name.endsWith('s')
          ? name.slice(0, -1)
          : name
      throw new Error(
        `No DTO found for table \`${name}\`. Options:\n` +
          `  • Export \`${singular}DtoSchema\` (or \`${name}DtoSchema\`) from packages/contracts/src/\n` +
          `  • Add \`${name}\` to DTO_NAME_OVERRIDES if the DTO export is named differently\n` +
          `  • Add \`${name}\` to TABLES_WITHOUT_DTOS with a one-line reason if it's internal-only`,
      )
    })

    if (!dto) continue

    it(`every column in ${name} is exposed on its DTO or marked internal`, () => {
      const dbColumns = Object.keys(getTableColumns(table))
      const dtoFields = Object.keys(dto.shape)
      const internal = INTERNAL_COLUMNS[name] ?? {}

      const orphaned = dbColumns.filter(
        (col) => !dtoFields.includes(col) && !(col in internal),
      )

      if (orphaned.length > 0) {
        const dtoName = dto.description ?? `${name}DtoSchema`
        const hint = orphaned
          .map((col) => `    - ${col}: add to ${dtoName} OR list in INTERNAL_COLUMNS.${name} with a reason`)
          .join('\n')
        throw new Error(
          `Table \`${name}\` has columns not exposed on its DTO and not marked internal:\n${hint}\n\n` +
            `If the column should be returned to users: add it to ${dtoName} in packages/contracts/src/.\n` +
            `If the column is internal-only: list it in packages/api-routes/test/db-dto-coverage.test.ts\n` +
            `under INTERNAL_COLUMNS.${name} with a one-line reason.`,
        )
      }

      expect(orphaned).toEqual([])
    })

    it(`INTERNAL_COLUMNS.${name} entries reference real columns`, () => {
      const dbColumns = new Set(Object.keys(getTableColumns(table)))
      const stale = Object.keys(INTERNAL_COLUMNS[name] ?? {}).filter((col) => !dbColumns.has(col))
      expect(stale, `Stale entries in INTERNAL_COLUMNS.${name}: ${stale.join(', ')}`).toEqual([])
    })
  }
})
