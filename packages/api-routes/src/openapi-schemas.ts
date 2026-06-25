/**
 * Centralized OpenAPI schema registry for canonry's API responses.
 *
 * Each Zod schema registered here becomes a `components.schemas.<Name>` entry
 * in the generated OpenAPI document. Route definitions reference them via
 * `$ref` so the spec stays DRY and codegen tools produce one TS type per
 * named schema.
 *
 * Conversion uses Zod v4's built-in `z.toJSONSchema(schema, { target:
 * 'openapi-3.0' })` — no third-party converter needed.
 *
 * Adding a new response shape:
 * 1. Add the entry to `SCHEMA_TABLE` (alphabetized).
 * 2. Reference it from a route via `jsonResponse('description', 'SchemaName')`.
 * 3. TypeScript enforces the schema name is registered — typos become
 *    compile errors, not silent broken `$ref`s.
 *
 * If a response shape has no matching Zod schema in `@ainyc/canonry-contracts`,
 * either:
 *   (a) add it to contracts first (preferred — keeps contracts the single
 *       source of truth), or
 *   (b) use `rawJsonResponse(description, jsonSchema)` as a temporary escape
 *       hatch and TODO it for migration.
 */
import { z, type ZodType } from 'zod'
import {
  agentProvidersResponseDtoSchema,
  apiKeyDtoSchema,
  apiKeyListDtoSchema,
  auditLogEntrySchema,
  createApiKeyRequestSchema,
  createdApiKeyDtoSchema,
  backlinkHistoryEntrySchema,
  backlinkListResponseSchema,
  backlinkSourcesResponseSchema,
  backlinkSummaryDtoSchema,
  backlinksInstallResultDtoSchema,
  backlinksInstallStatusDtoSchema,
  bingConnectResponseDtoSchema,
  bingCoverageSnapshotDtoSchema,
  bingCoverageSummaryDtoSchema,
  bingIndexingRequestResponseDtoSchema,
  bingKeywordStatsDtoSchema,
  bingSetSiteResponseDtoSchema,
  bingSitesResponseDtoSchema,
  bingStatusDtoSchema,
  bingUrlInspectionDtoSchema,
  brandMetricsDtoSchema,
  ccAvailableReleaseSchema,
  ccCachedReleaseSchema,
  ccReleaseSyncDtoSchema,
  cdpStatusDtoSchema,
  citationVisibilityResponseSchema,
  competitorDtoSchema,
  contentGapsResponseDtoSchema,
  contentSourcesResponseDtoSchema,
  contentTargetDismissalDtoSchema,
  contentTargetDismissalsResponseDtoSchema,
  contentTargetsResponseDtoSchema,
  domainClassificationsResponseDtoSchema,
  recommendationBriefDtoSchema,
  recommendationExplanationDtoSchema,
  discoveryHarvestDtoSchema,
  discoveryPromotePreviewSchema,
  discoveryPromoteResultSchema,
  discoverySessionDetailDtoSchema,
  discoverySessionDtoSchema,
  doctorReportSchema,
  ga4AiReferralHistoryEntrySchema,
  ga4SessionHistoryEntrySchema,
  ga4SocialReferralHistoryEntrySchema,
  ga4StatusDtoSchema,
  ga4SyncResponseDtoSchema,
  gbpAccountListResponseSchema,
  gbpLocationDtoSchema,
  gbpLocationListResponseSchema,
  gbpSyncResponseSchema,
  gbpDailyMetricListResponseSchema,
  gbpKeywordImpressionListResponseSchema,
  gbpPlaceActionListResponseSchema,
  gbpLodgingListResponseSchema,
  gbpAttributesListResponseSchema,
  gbpPlaceDetailsListResponseSchema,
  gbpSummaryDtoSchema,
  googleConnectionDtoSchema,
  gscCoverageSnapshotDtoSchema,
  gscCoverageSummaryDtoSchema,
  gscDeindexedRowSchema,
  gscPerformanceDailyDtoSchema,
  gscSearchDataDtoSchema,
  gscSiteListResponseDtoSchema,
  gscSitemapListResponseDtoSchema,
  gscUrlInspectionDtoSchema,
  indexingRequestResponseDtoSchema,
  keywordDtoSchema,
  latestProjectRunDtoSchema,
  locationContextSchema,
  notificationDtoSchema,
  projectDtoSchema,
  projectOverviewDtoSchema,
  projectReportDtoSchema,
  queryDtoSchema,
  runDetailDtoSchema,
  adsCampaignListResponseSchema,
  adsConnectionStatusDtoSchema,
  adsDisconnectResponseSchema,
  adsInsightsResponseSchema,
  adsSummaryDtoSchema,
  adsSyncResponseSchema,
  runDtoSchema,
  schedulableRunKindSchema,
  scheduleDtoSchema,
  settingsDtoSchema,
  siteAuditScoreSchema,
  siteAuditPagesResponseSchema,
  siteAuditTrendResponseSchema,
  siteAuditRunResponseSchema,
  snapshotDiffResponseSchema,
  snapshotListResponseSchema,
  snapshotReportSchema,
  sourceBreakdownDtoSchema,
  cloudflareWorkerIngestRequestSchema,
  cloudflareWorkerIngestResponseSchema,
  trafficBackfillResponseSchema,
  trafficConnectCloudflareRequestSchema,
  trafficConnectCloudflareResponseSchema,
  trafficEventsResponseSchema,
  trafficSourceDetailDtoSchema,
  trafficSourceDtoSchema,
  trafficSourceListResponseSchema,
  trafficStatusResponseSchema,
  trafficSyncResponseSchema,
  visibilityStatsDtoSchema,
  wordpressAuditPageDtoSchema,
  wordpressBulkMetaResultDtoSchema,
  wordpressDiffDtoSchema,
  wordpressManualAssistDtoSchema,
  wordpressOnboardResultDtoSchema,
  wordpressPageDetailDtoSchema,
  wordpressPageSummaryDtoSchema,
  wordpressSchemaBlockDtoSchema,
  wordpressSchemaDeployResultDtoSchema,
  wordpressSchemaStatusResultDtoSchema,
  wordpressStatusDtoSchema,
} from '@ainyc/canonry-contracts'

/**
 * Schemas registered here become referenceable by their component name from
 * any route definition. Keep alphabetized by component name so additions are
 * obvious in review.
 */
const SCHEMA_TABLE = {
  AgentProvidersResponseDto: agentProvidersResponseDtoSchema,
  AdsCampaignListResponse: adsCampaignListResponseSchema,
  AdsConnectionStatusDto: adsConnectionStatusDtoSchema,
  AdsDisconnectResponse: adsDisconnectResponseSchema,
  AdsInsightsResponse: adsInsightsResponseSchema,
  AdsSummaryDto: adsSummaryDtoSchema,
  AdsSyncResponse: adsSyncResponseSchema,
  ApiKeyDto: apiKeyDtoSchema,
  ApiKeyListDto: apiKeyListDtoSchema,
  AuditLogEntry: auditLogEntrySchema,
  BacklinkHistoryEntry: backlinkHistoryEntrySchema,
  BacklinkListResponse: backlinkListResponseSchema,
  BacklinkSourcesResponse: backlinkSourcesResponseSchema,
  BacklinkSummaryDto: backlinkSummaryDtoSchema,
  BacklinksInstallResultDto: backlinksInstallResultDtoSchema,
  BacklinksInstallStatusDto: backlinksInstallStatusDtoSchema,
  BingConnectResponseDto: bingConnectResponseDtoSchema,
  BingCoverageSnapshotDto: bingCoverageSnapshotDtoSchema,
  BingCoverageSummaryDto: bingCoverageSummaryDtoSchema,
  BingIndexingRequestResponseDto: bingIndexingRequestResponseDtoSchema,
  BingKeywordStatsDto: bingKeywordStatsDtoSchema,
  BingSetSiteResponseDto: bingSetSiteResponseDtoSchema,
  BingSitesResponseDto: bingSitesResponseDtoSchema,
  BingStatusDto: bingStatusDtoSchema,
  BingUrlInspectionDto: bingUrlInspectionDtoSchema,
  BrandMetricsDto: brandMetricsDtoSchema,
  CcAvailableRelease: ccAvailableReleaseSchema,
  CcCachedRelease: ccCachedReleaseSchema,
  CcReleaseSyncDto: ccReleaseSyncDtoSchema,
  CdpStatusDto: cdpStatusDtoSchema,
  CitationVisibilityResponse: citationVisibilityResponseSchema,
  CompetitorDto: competitorDtoSchema,
  ContentGapsResponseDto: contentGapsResponseDtoSchema,
  ContentSourcesResponseDto: contentSourcesResponseDtoSchema,
  ContentTargetDismissalDto: contentTargetDismissalDtoSchema,
  ContentTargetDismissalsResponseDto: contentTargetDismissalsResponseDtoSchema,
  ContentTargetsResponseDto: contentTargetsResponseDtoSchema,
  CreateApiKeyRequest: createApiKeyRequestSchema,
  CreatedApiKeyDto: createdApiKeyDtoSchema,
  DomainClassificationsResponseDto: domainClassificationsResponseDtoSchema,
  RecommendationBriefDto: recommendationBriefDtoSchema,
  RecommendationExplanationDto: recommendationExplanationDtoSchema,
  DiscoveryHarvestDto: discoveryHarvestDtoSchema,
  DiscoveryPromotePreview: discoveryPromotePreviewSchema,
  DiscoveryPromoteResult: discoveryPromoteResultSchema,
  DiscoverySessionDetailDto: discoverySessionDetailDtoSchema,
  DiscoverySessionDto: discoverySessionDtoSchema,
  DoctorReportDto: doctorReportSchema,
  GA4AiReferralHistoryEntry: ga4AiReferralHistoryEntrySchema,
  GA4SessionHistoryEntry: ga4SessionHistoryEntrySchema,
  GA4SocialReferralHistoryEntry: ga4SocialReferralHistoryEntrySchema,
  GA4StatusDto: ga4StatusDtoSchema,
  GA4SyncResponseDto: ga4SyncResponseDtoSchema,
  GbpAccountListResponse: gbpAccountListResponseSchema,
  GbpDailyMetricListResponse: gbpDailyMetricListResponseSchema,
  GbpKeywordImpressionListResponse: gbpKeywordImpressionListResponseSchema,
  GbpLocationDto: gbpLocationDtoSchema,
  GbpLocationListResponse: gbpLocationListResponseSchema,
  GbpLodgingListResponse: gbpLodgingListResponseSchema,
  GbpAttributesListResponse: gbpAttributesListResponseSchema,
  GbpPlaceActionListResponse: gbpPlaceActionListResponseSchema,
  GbpPlaceDetailsListResponse: gbpPlaceDetailsListResponseSchema,
  GbpSummaryDto: gbpSummaryDtoSchema,
  GbpSyncResponse: gbpSyncResponseSchema,
  GoogleConnectionDto: googleConnectionDtoSchema,
  GscCoverageSnapshotDto: gscCoverageSnapshotDtoSchema,
  GscCoverageSummaryDto: gscCoverageSummaryDtoSchema,
  GscDeindexedRowDto: gscDeindexedRowSchema,
  GscPerformanceDailyDto: gscPerformanceDailyDtoSchema,
  GscSearchDataDto: gscSearchDataDtoSchema,
  GscSiteListResponseDto: gscSiteListResponseDtoSchema,
  GscSitemapListResponseDto: gscSitemapListResponseDtoSchema,
  GscUrlInspectionDto: gscUrlInspectionDtoSchema,
  IndexingRequestResponseDto: indexingRequestResponseDtoSchema,
  KeywordDto: keywordDtoSchema,
  LatestProjectRunDto: latestProjectRunDtoSchema,
  LocationContext: locationContextSchema,
  NotificationDto: notificationDtoSchema,
  ProjectDto: projectDtoSchema,
  ProjectOverviewDto: projectOverviewDtoSchema,
  ProjectReportDto: projectReportDtoSchema,
  QueryDto: queryDtoSchema,
  RunDetailDto: runDetailDtoSchema,
  RunDto: runDtoSchema,
  SchedulableRunKind: schedulableRunKindSchema,
  ScheduleDto: scheduleDtoSchema,
  SettingsDto: settingsDtoSchema,
  SiteAuditPagesResponseDto: siteAuditPagesResponseSchema,
  SiteAuditRunResponseDto: siteAuditRunResponseSchema,
  SiteAuditScoreDto: siteAuditScoreSchema,
  SiteAuditTrendResponseDto: siteAuditTrendResponseSchema,
  SnapshotDiffResponse: snapshotDiffResponseSchema,
  SnapshotListResponse: snapshotListResponseSchema,
  SnapshotReportDto: snapshotReportSchema,
  SourceBreakdownDto: sourceBreakdownDtoSchema,
  CloudflareWorkerIngestRequest: cloudflareWorkerIngestRequestSchema,
  CloudflareWorkerIngestResponse: cloudflareWorkerIngestResponseSchema,
  TrafficBackfillResponse: trafficBackfillResponseSchema,
  TrafficConnectCloudflareRequest: trafficConnectCloudflareRequestSchema,
  TrafficConnectCloudflareResponse: trafficConnectCloudflareResponseSchema,
  TrafficEventsResponse: trafficEventsResponseSchema,
  TrafficSourceDetailDto: trafficSourceDetailDtoSchema,
  TrafficSourceDto: trafficSourceDtoSchema,
  TrafficSourceListResponse: trafficSourceListResponseSchema,
  TrafficStatusResponse: trafficStatusResponseSchema,
  TrafficSyncResponse: trafficSyncResponseSchema,
  VisibilityStatsDto: visibilityStatsDtoSchema,
  WordpressAuditPageDto: wordpressAuditPageDtoSchema,
  WordpressBulkMetaResultDto: wordpressBulkMetaResultDtoSchema,
  WordpressDiffDto: wordpressDiffDtoSchema,
  WordpressManualAssistDto: wordpressManualAssistDtoSchema,
  WordpressOnboardResultDto: wordpressOnboardResultDtoSchema,
  WordpressPageDetailDto: wordpressPageDetailDtoSchema,
  WordpressPageSummaryDto: wordpressPageSummaryDtoSchema,
  WordpressSchemaBlockDto: wordpressSchemaBlockDtoSchema,
  WordpressSchemaDeployResultDto: wordpressSchemaDeployResultDtoSchema,
  WordpressSchemaStatusResultDto: wordpressSchemaStatusResultDtoSchema,
  WordpressStatusDto: wordpressStatusDtoSchema,

  // Shared envelope used by every 4xx/5xx response. Defined locally because
  // the API never returns this from a typed handler — it's emitted by the
  // global error handler. Codegen consumers reference it through the
  // ErrorEnvelope ref so error shape is part of the public contract.
  ErrorEnvelope: z.object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  }),
} satisfies Record<string, ZodType>

/**
 * Names of every schema known to the table. Use this for typed schema
 * references in route definitions — typos become compile errors instead of
 * silent broken `$ref`s.
 */
export type RegisteredSchemaName = keyof typeof SCHEMA_TABLE

/**
 * Properties whose value is a shared enum that also exists as its own
 * component. Zod's `toJSONSchema` inlines the enum union at every use site;
 * we rewrite those occurrences to a `$ref` so codegen emits ONE named TS type
 * (e.g. `SchedulableRunKind`) instead of repeating the union in every DTO.
 * Both sides derive from the same Zod schema, so the values can't drift.
 * Route-level uses (query params, request bodies) `$ref` the component
 * directly in `openapi.ts`.
 */
const SHARED_ENUM_REFS: ReadonlyArray<{ schema: RegisteredSchemaName; property: string; component: RegisteredSchemaName }> = [
  { schema: 'ScheduleDto', property: 'kind', component: 'SchedulableRunKind' },
]

/**
 * Convert every registered schema to its OpenAPI 3.0 JSON Schema. Called once
 * during spec build, embedded as `components.schemas` in the OpenAPI doc.
 */
export function buildComponentSchemas(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, schema] of Object.entries(SCHEMA_TABLE) as [string, ZodType][]) {
    out[name] = z.toJSONSchema(schema, { target: 'openapi-3.0' }) as Record<string, unknown>
  }
  for (const { schema, property, component } of SHARED_ENUM_REFS) {
    const properties = out[schema]?.properties as Record<string, unknown> | undefined
    if (properties && properties[property]) {
      properties[property] = { $ref: `#/components/schemas/${component}` }
    }
  }
  return out
}

/**
 * Helper that produces a response object referencing a registered schema by
 * name. The generated OpenAPI document expands it to a `$ref` against
 * `components.schemas`.
 */
export function jsonResponse(description: string, schemaName: RegisteredSchemaName) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schemaName}` },
      },
    },
  }
}

/**
 * Helper that wraps a registered schema as an array response.
 */
export function jsonArrayResponse(description: string, schemaName: RegisteredSchemaName) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: { $ref: `#/components/schemas/${schemaName}` },
        },
      },
    },
  }
}

/**
 * Escape hatch for endpoints whose response shape does not (yet) have a
 * registered Zod schema. Inlines a raw JSON Schema. Prefer migrating the
 * shape into `packages/contracts` and using `jsonResponse` instead.
 */
export function rawJsonResponse(description: string, schema: Record<string, unknown>) {
  return {
    description,
    content: {
      'application/json': { schema },
    },
  }
}

/**
 * Loose-object response — for endpoints whose shape is intentionally ad-hoc
 * or not yet stabilized. Codegen tools will emit these as `Record<string,
 * unknown>` returns.
 */
export const looseObjectSchema = { type: 'object', additionalProperties: true } as const

/**
 * Standard error-envelope response — every 4xx/5xx response should use this.
 */
export function errorResponse(description: string) {
  return jsonResponse(description, 'ErrorEnvelope')
}
