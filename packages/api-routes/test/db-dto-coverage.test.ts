import { describe, expect, it } from 'vitest'
import { getTableColumns, getTableName, is, Table } from 'drizzle-orm'
import { z } from 'zod'
import * as dbSchema from '@ainyc/canonry-db'
import {
  adsAdDtoSchema,
  adsAdGroupDtoSchema,
  adsCampaignDtoSchema,
  adsConnectionStatusDtoSchema,
  adsInsightRowDtoSchema,
  adsActivationGrantDtoSchema,
  adsOperationDtoSchema,
  adsOperationStepDtoSchema,
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
  researchRunQuerySchema,
  researchRunSummarySchema,
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
  gbpAttributesDtoSchema,
  gbpPlaceDetailsDtoSchema,
  googleConnectionDtoSchema,
  googleAdsConnectionMetadataDtoSchema,
  googleAdsRawSnapshotMetadataDtoSchema,
  gscCoverageSnapshotDtoSchema,
  gscSearchDataDtoSchema,
  gscUrlInspectionDtoSchema,
  notificationDtoSchema,
  projectDtoSchema,
  queryDtoSchema,
  querySnapshotDtoSchema,
  recommendationExplanationDtoSchema,
  recommendationBriefDtoSchema,
  domainClassificationDtoSchema,
  runDtoSchema,
  scheduleDtoSchema,
  siteAuditScoreSchema,
  siteAuditPageSchema,
  siteCrawlEdgeSchema,
  siteCrawlGraphEdgeSchema,
  siteCrawlGraphLayoutSchema,
  siteCrawlGraphNodeSchema,
  siteCrawlPageSchema,
  siteCrawlSummarySchema,
  trafficSourceDtoSchema,
  conversionTrackingContractSchema,
  gtmConnectionMetadataDtoSchema,
  gtmRawSnapshotMetadataDtoSchema,
  userDtoSchema,
  measurementQuerySetSchema,
  measurementQueryTemplateSchema,
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
      dto: z.ZodType
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
      measurementExecutionId: 'Plan-run attribution; read through the measurement report, not the snapshot DTO.',
      screenshotPath: 'Debug-only artifact path; not surfaced on the snapshot DTO.',
      rawResponse: 'Raw provider payload; exposed via a separate endpoint, not the snapshot DTO.',
    },
  },
  schedules: {
    kind: 'dto',
    dto: scheduleDtoSchema,
    internal: {},
  },
  siteAuditSnapshots: {
    kind: 'dto',
    dto: siteAuditScoreSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope (/projects/:name/technical-aeo).',
      factorAverages: 'Exposed as `factors` on the score DTO.',
      createdAt: 'Row insert timestamp; the audit time is surfaced as auditedAt.',
    },
  },
  siteAuditPages: {
    kind: 'dto',
    dto: siteAuditPageSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope (/projects/:name/technical-aeo/pages).',
      runId: 'Internal join key — the latest surfaceable run is resolved server-side.',
      createdAt: 'Row insert timestamp.',
    },
  },
  siteCrawlSnapshots: {
    kind: 'dto',
    dto: siteCrawlSummarySchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the project-scoped route.',
      attemptId: 'Exact detail attempt; retained to scope graph reads.',
      pageBudget: 'Preserved inside effectiveOptions or runtime defaults, not a separate response field.',
      edgeBudget: 'Preserved inside effectiveOptions or runtime defaults, not a separate response field.',
      maxDepth: 'Preserved inside effectiveOptions or runtime defaults, not a separate response field.',
      checkDeadLinks: 'Represented by the discriminated deadLinks state.',
      pagesDiscovered: 'Nested in counts.',
      pagesFetched: 'Nested in counts.',
      pagesEligible: 'Nested in counts.',
      pagesErrored: 'Diagnostic count not surfaced in the graph summary.',
      edgesDiscovered: 'Nested in counts as edges.',
      findingsCount: 'Nested in counts as findings.',
      deadLinkState: 'Represented by the discriminated deadLinks state.',
      deadLinksChecked: 'Represented by the discriminated deadLinks state.',
      deadLinksFound: 'Represented by the discriminated deadLinks state.',
      deadLinksUnverified: 'Represented by the discriminated deadLinks state.',
      templateDetection: 'Surfaced as templateDetection on every link-bearing response (graph, internal-links, neighbors), not on the crawl summary.',
      linkPlacementRulesetVersion: 'Which rule classified the links is reported as templateDetection on the link-bearing responses; the raw ruleset version is crawl-engine provenance.',
      createdAt: 'Storage timestamp; the summary represents the selected run.',
      updatedAt: 'Storage timestamp; the summary represents the selected run.',
    },
  },
  siteCrawlPages: {
    kind: 'dto',
    dto: siteCrawlPageSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the project-scoped route.',
      runId: 'Selected server-side.',
      attemptId: 'Selected server-side.',
      discoveryProvenance: 'Detailed provenance is retained for diagnostics, not this list row.',
      sitemapMetadata: 'Raw sitemap metadata is not needed by the inventory list.',
      fetchedAt: 'Fetch timestamp is diagnostic evidence.',
      contentType: 'Raw response metadata is diagnostic evidence.',
      redirectChain: 'Detailed redirect evidence is retrieved from the stored crawl only when needed.',
      directives: 'Raw directives are compacted into indexability state/reasons.',
      canonicalNodeKey: 'Internal deterministic join key.',
      auditFields: 'Raw audit payload is not included in a bounded inventory row.',
      createdAt: 'Storage timestamp.',
      updatedAt: 'Storage timestamp.',
    },
  },
  siteCrawlEdges: {
    kind: 'dto',
    dto: siteCrawlEdgeSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the project-scoped route.',
      runId: 'Selected server-side.',
      attemptId: 'Selected server-side.',
      placementNavigationOccurrences: 'Nested in placementOccurrences.',
      placementContentOccurrences: 'Nested in placementOccurrences.',
      placementUnknownOccurrences: 'Nested in placementOccurrences.',
      createdAt: 'Storage timestamp.',
      updatedAt: 'Storage timestamp.',
    },
  },
  siteCrawlGraphLayouts: {
    kind: 'dto',
    dto: siteCrawlGraphLayoutSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the project-scoped route.',
      runId: 'Selected server-side with the crawl snapshot.',
      attemptId: 'Internal join key for the exact crawl attempt.',
      layoutVersion: 'Serialized as `version` when the layout is ready.',
      failureCode: 'Translated to the unavailable layout reason by the graph response.',
      totalNodes: 'Surfaced on the enclosing graph response, not the layout DTO.',
      totalEdges: 'Surfaced on the enclosing graph response, not the layout DTO.',
      totalTemplateEdges: 'Surfaced on the enclosing graph response as totalTemplateEdges, not the layout DTO.',
      nodeCount: 'Persisted sample bookkeeping; the response returns its node rows.',
      edgeCount: 'Persisted sample bookkeeping; the response returns its edge rows.',
      createdAt: 'Serialized as `computedAt` when the layout is ready.',
      updatedAt: 'Storage timestamp.',
    },
  },
  siteCrawlGraphNodes: {
    kind: 'dto',
    dto: siteCrawlGraphNodeSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the project-scoped route.',
      runId: 'Selected server-side with the crawl snapshot.',
      attemptId: 'Internal join key for the exact crawl attempt.',
      sampleRank: 'Deterministic bounded-read ordering; not a page attribute.',
      createdAt: 'Storage timestamp.',
    },
  },
  siteCrawlGraphEdges: {
    kind: 'dto',
    dto: siteCrawlGraphEdgeSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the project-scoped route.',
      runId: 'Selected server-side with the crawl snapshot.',
      attemptId: 'Internal join key for the exact crawl attempt.',
      sampleRank: 'Deterministic bounded-read ordering; not a link attribute.',
      createdAt: 'Storage timestamp.',
    },
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
  googleAdsConnections: {
    kind: 'dto',
    dto: googleAdsConnectionMetadataDtoSchema,
    internal: {
      selectionGeneration: 'Internal monotonic CAS token that invalidates in-flight syncs after every selection or OAuth reconnect.',
      selectedLoginCustomerId: 'Nested under the public connection selection object.',
      selectedCustomerId: 'Nested under the public connection selection object.',
      selectedCustomerName: 'Safe discovery cache used to format status; exposed through the selected-customer DTO, not connection metadata.',
      selectedCustomerCurrencyCode: 'Safe discovery cache used to format status; exposed through the selected-customer DTO, not connection metadata.',
      selectedCustomerTimeZone: 'Safe discovery cache used to format status; exposed through the selected-customer DTO, not connection metadata.',
      selectedCustomerStatus: 'Safe discovery cache used to format status; exposed through the selected-customer DTO, not connection metadata.',
      lastCustomerSnapshotId: 'Internal exact stored-evidence anchor for the current selection generation.',
      lastInventorySnapshotId: 'Internal exact stored-evidence anchor for the current selection generation.',
      lastMetricsSnapshotId: 'Internal exact stored-evidence anchor for the current selection generation.',
    },
  },
  gtmConnections: {
    kind: 'dto',
    dto: gtmConnectionMetadataDtoSchema,
    internal: {
      selectionGeneration: 'Internal monotonic CAS token that invalidates in-flight syncs after every selection or OAuth reconnect.',
      selectedAccountId: 'Nested under the public connection selection object.',
      selectedAccountName: 'Safe discovery cache used to format status, not connection metadata.',
      selectedContainerId: 'Nested under the public connection selection object.',
      selectedContainerName: 'Safe discovery cache used to format status, not connection metadata.',
      selectedContainerPublicId: 'Safe discovery cache used to format status, not connection metadata.',
      selectedWorkspaceId: 'Nested under the public connection selection object.',
      selectedWorkspaceName: 'Safe discovery cache used to format status, not connection metadata.',
      lastSnapshotId: 'Internal exact stored-evidence anchor for the current selection generation.',
    },
  },
  conversionTrackingContracts: {
    kind: 'dto',
    dto: conversionTrackingContractSchema,
    internal: {},
  },
  googleAdsRawSnapshots: {
    kind: 'dto',
    dto: googleAdsRawSnapshotMetadataDtoSchema,
    internal: {
      payload: 'Returned beside metadata in the typed stored-snapshot envelope, not inside metadata.',
    },
  },
  gtmRawSnapshots: {
    kind: 'dto',
    dto: gtmRawSnapshotMetadataDtoSchema,
    internal: {
      payload: 'Returned beside metadata in the typed stored-snapshot envelope, not inside metadata.',
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
  adsConnections: {
    kind: 'dto',
    dto: adsConnectionStatusDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      createdAt: 'Internal bookkeeping.',
      updatedAt: 'Internal bookkeeping.',
    },
  },
  adsOperations: {
    kind: 'dto',
    dto: adsOperationDtoSchema,
    internal: {
      projectId: 'Implied by the route scope.',
      requestHash: 'Internal idempotency guard; never exposed on the operation receipt.',
      leaseOwner: 'Internal worker token used to prevent stale reconciler writes.',
      leaseExpiresAt: 'Internal lease boundary used by the bounded receipt sweeper.',
    },
  },
  adsActivationGrants: {
    kind: 'dto',
    dto: adsActivationGrantDtoSchema,
    internal: {},
  },
  adsOperationSteps: {
    kind: 'dto',
    dto: adsOperationStepDtoSchema,
    internal: {},
  },
  adsCampaigns: {
    kind: 'dto',
    dto: adsCampaignDtoSchema,
    internal: {
      projectId: 'Implied by the route scope.',
      targeting: 'Raw upstream geo-targeting JSON; projected to locationIds on the DTO.',
      upstreamCreatedAt: 'Upstream bookkeeping epoch; not part of the read DTO.',
      syncRunId: 'Internal join key.',
    },
  },
  adsAdGroups: {
    kind: 'dto',
    dto: adsAdGroupDtoSchema,
    internal: {
      projectId: 'Implied by the route scope.',
      upstreamCreatedAt: 'Upstream bookkeeping epoch; not part of the read DTO.',
      syncRunId: 'Internal join key.',
    },
  },
  adsAds: {
    kind: 'dto',
    dto: adsAdDtoSchema,
    internal: {
      projectId: 'Implied by the route scope.',
      upstreamCreatedAt: 'Upstream bookkeeping epoch; not part of the read DTO.',
      syncRunId: 'Internal join key.',
    },
  },
  adsInsightsDaily: {
    kind: 'dto',
    dto: adsInsightRowDtoSchema,
    internal: {
      id: 'Surrogate key.',
      projectId: 'Implied by the route scope.',
      syncRunId: 'Internal join key.',
    },
  },
  queryBasketVersions: {
    kind: 'internal-only',
    reason: 'Immutable snapshots of a project\'s tracked query set, recorded so analytics can compare like-for-like instead of inferring measurement-set membership from query row timestamps. Consumed only by the analytics response, which surfaces the parts a reader needs (`referenceBasketRevision`, per-bucket `basketRevision`, and `basketChanges`); the raw membership blob is an internal comparison key.',
  },
    insightNotifyState: {
      kind: 'internal-only',
      reason: 'What an insight webhook has already said, so it stops saying it. Alerting bookkeeping in exactly the sense doctorHealthState is: it records the identity of a delivered finding (project, type, subject, and the title with its magnitude neutralised) so a finding that persists across runs notifies once rather than on every run. Nothing here is a measurement, the insights themselves are served by the insights routes, and exposing send-state would invite a reader to mistake \'already alerted\' for \'still true\'.',
    },
  doctorHealthState: {
    kind: 'internal-only',
    reason: 'Last observed doctor outcome per project, kept only so health alerting can fire on transitions rather than on every scheduled pass. It is alerting bookkeeping, not a measurement: the report itself is served live by GET /projects/:name/doctor, and exposing a cached copy would invite readers to trust a stale health verdict.',
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
  gbpAttributesSnapshots: {
    kind: 'dto',
    dto: gbpAttributesDtoSchema,
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
  gscDataWatermarks: {
    kind: 'internal-only',
    reason: 'Monotonic per-project GSC frontier (furthest reporting date ever observed, plus how far the last sync asked). Read through `readLatestGscDataDate` to anchor windows; surfaced only as the derived `window` block on the performance/daily response, never as a row DTO.',
  },
  gscDailyTotals: {
    kind: 'internal-only',
    reason: 'Property-level daily GSC totals (no query/page dims). Backing store for the report `gsc` headline/trend + the gsc performance/daily response; not exposed as a direct row DTO.',
  },
  gscQueryDailyTotals: {
    kind: 'internal-only',
    reason: 'Per-query daily GSC totals fetched without the `page` dimension, so Google deduplicates a multi-page SERP into the one impression it was. Backing store for the report top-queries + suggested-queries reads; not exposed as a direct row DTO. Mirrors gscDailyTotals.',
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
  gaAcquisitionDaily: {
    kind: 'internal-only',
    reason: 'Typed GA4 acquisition foundation; its public read model lands in the follow-up measurement API PR.',
  },
  gaLeadEventsDaily: {
    kind: 'internal-only',
    reason: 'Typed GA4 attributed lead-event foundation; its public read model lands in the follow-up measurement API PR.',
  },
  gaMeasurementSyncStates: {
    kind: 'internal-only',
    reason: 'Component-level sync completeness and error state backing the follow-up measurement API.',
  },
  gaDailyTotals: {
    kind: 'internal-only',
    reason: 'Property-level daily GA4 totals (no landing-page dim), the deduplicated `users` source for the session-history response. Backing store only — its values reach callers through that response, not as a direct row DTO. Mirrors gscDailyTotals.',
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
  researchRuns: {
    kind: 'dto',
    dto: researchRunSummarySchema,
    internal: {
      idempotencyKey: 'Retry deduplication key is never returned.',
      requestHash: 'Internal idempotency comparison only.',
    },
  },
  researchRunQueries: {
    kind: 'dto',
    dto: researchRunQuerySchema,
    internal: {
      researchRunId: 'Implied by the enclosing detail route.',
      queryText: 'Serialized as the public `query` field.',
      rawResponse: 'Raw provider payload retained for diagnostics.',
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
  recommendationBriefs: {
    kind: 'dto',
    dto: recommendationBriefDtoSchema,
    internal: {
      id: 'Surrogate key; briefs are addressed by (projectId, targetRef, promptVersion).',
      projectId: 'Implied by the route scope (/projects/:name/content/recommendations/:targetRef/brief).',
    },
  },
  domainClassifications: {
    kind: 'dto',
    dto: domainClassificationDtoSchema,
    internal: {
      id: 'Surrogate key; classifications are addressed by (projectId, domain).',
      projectId: 'Implied by the route scope (/projects/:name/content/domain-classifications).',
      sessionId: 'Provenance of the latest classifying discovery session; not part of the public surface.',
    },
  },
  trafficSources: {
    kind: 'dto',
    dto: trafficSourceDtoSchema,
    internal: {
      lastEventIds: 'Bounded ring buffer of recent event IDs; internal dedup state, not part of the source DTO.',
      wordpressPendingUntil: 'Fixed upper bound paired with a WordPress continuation cursor; internal sync state, not part of the source DTO.',
      configJson: 'Exposed on the DTO as `config`; the DB column keeps the `Json` suffix for grep-ability.',
      ingestTokenHash: 'sha256 of the per-source bearer token issued to push-receive adapters (Cloudflare Worker). Auth-only — never returned via the DTO.',
      lastWorkerVersion: 'Semver reported by the most recently ingested Cloudflare Worker batch, whether direct or Queue. Surfaced through the doctor check, not the source DTO.',
      syncLeaseOwner: 'Ephemeral owner of a pull-source sync lease; internal concurrency state.',
      syncLeaseExpiresAt: 'Expiry for stale pull-source lease recovery; internal concurrency state.',
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
  users: {
    kind: 'dto',
    dto: userDtoSchema,
    internal: {
      passwordHash: 'Salted password digest; never leaves the server under any circumstance.',
      nameKey: 'Lower-cased name used only to keep near-duplicate accounts from existing.',
    },
  },
  userSessions: {
    kind: 'internal-only',
    reason: 'Live sign-in sessions; the row id IS the cookie value and is never returned in a response body.',
  },
  measurementPlans: {
    kind: 'internal-only',
    reason: 'Active-version pointer; the measurement-plan API returns the compiled aggregate, not this row.',
  },
  measurementPlanVersions: {
    kind: 'internal-only',
    reason: 'Immutable canonical JSON backing the compiled measurement-plan API, not a direct row DTO.',
  },
  simpleMeasurementDefinitions: {
    kind: 'internal-only',
    reason: 'Frozen dispatch inputs for future reporting adapters. Existing run DTOs and reporting behavior remain unchanged.',
  },
  measurementSegments: {
    kind: 'internal-only',
    reason: 'Stable target/group identity anchor; labels and attribution rules remain in immutable plan JSON.',
  },
  measurementPlanDrafts: {
    kind: 'internal-only',
    reason: 'Authoring draft storage; the draft API returns the parsed authoring document and an ETag, not this row.',
  },
  measurementQuerySets: {
    kind: 'dto',
    dto: measurementQuerySetSchema,
    internal: {},
  },
  measurementQuerySetItems: {
    kind: 'internal-only',
    reason: 'Ordered membership rows; returned only inside a query-set detail, never as a row of their own.',
  },
  measurementQueryTemplates: {
    kind: 'dto',
    dto: measurementQueryTemplateSchema,
    internal: {},
  },
  measurementDiscoveryConfigs: {
    kind: 'internal-only',
    reason: 'Recorded discovery inputs for determinism; the draft carries the operator-facing copy of them.',
  },
  measurementOperationReceipts: {
    kind: 'internal-only',
    reason: 'Idempotency receipts. A replay returns the stored response body, never the receipt row.',
  },
  siteCrawlAttempts: {
    kind: 'internal-only',
    reason: 'Local crawl checkpoint state; public reads resolve the completed snapshot rather than expose attempts.',
  },
  siteCrawlRunRequests: {
    kind: 'internal-only',
    reason: 'Persisted in-flight consolidation identity; conflicts expose only bounded error details, never this storage row.',
  },
  siteCrawlFindings: {
    kind: 'internal-only',
    reason: 'Typed composite endpoints selectively expose bounded finding projections (such as dead links), not raw finding rows.',
  },
  siteCrawlEventReceipts: {
    kind: 'internal-only',
    reason: 'Transactional idempotency receipts; never returned to an API caller.',
  },
  usageCounters: {
    kind: 'internal-only',
    reason: 'Internal rate-limit / quota counters; never exposed.',
  },
  oauthClients: {
    kind: 'internal-only',
    reason: 'OAuth client registry for the remote MCP surface. Credentials, not content: the secret is stored as a digest and nothing about a client is a public DTO.',
  },
  oauthAuthorizationCodes: {
    kind: 'internal-only',
    reason: 'In-flight OAuth codes, 60s TTL and single use. Exposing any of this would defeat the flow it implements.',
  },
  oauthTokens: {
    kind: 'internal-only',
    reason: 'Issued OAuth access and refresh tokens, stored as digests. A bearer credential is never a DTO.',
  },
  llmUsageEvents: {
    kind: 'internal-only',
    reason: 'Internal LLM token/cache/cost ledger for prompt-cache tuning; not exposed as a public DTO.',
  },
  agentToolEvents: {
    kind: 'internal-only',
    reason: 'Internal Aero tool-call ledger for long-session observability; not exposed as a public DTO.',
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
  crawlerVerificationManifestsHourly: {
    kind: 'internal-only',
    reason: 'Per-manifest crawler provenance consumed via /traffic/events composite, not directly mapped to a DTO.',
  },
  aiUserFetchEventsHourly: {
    kind: 'internal-only',
    reason: 'Hourly rollup consumed via /traffic/events composite, not directly mapped to a DTO.',
  },
  aiUserFetchVerificationManifestsHourly: {
    kind: 'internal-only',
    reason: 'Per-manifest AI user-fetch provenance consumed via /traffic/events composite, not directly mapped to a DTO.',
  },
  aiReferralEventsHourly: {
    kind: 'internal-only',
    reason: 'Hourly rollup consumed via /traffic/events composite, not directly mapped to a DTO.',
  },
  trafficEventReceipts: {
    kind: 'internal-only',
    reason: 'Transport-neutral transactional idempotency claims; never returned to an API caller.',
  },
  rawEventSamples: {
    kind: 'internal-only',
    reason: 'Short-retention raw evidence for classifier debugging; not part of the public API.',
  },
  migrationsTable: {
    kind: 'internal-only',
    reason: 'Internal migration bookkeeping; never exposed.',
  },
}

interface DiscoveredTable {
  prop: string
  dbName: string
  table: Parameters<typeof getTableColumns>[0]
}

function dtoFieldNames(schema: z.ZodType): string[] {
  if (schema instanceof z.ZodObject) return Object.keys(schema.shape)
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return [...new Set(schema.options.flatMap((option) => dtoFieldNames(option)))]
  }
  throw new Error(`Unsupported public DTO schema in DB coverage: ${schema.constructor.name}`)
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
        const dtoFields = dtoFieldNames(entry.dto)
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
