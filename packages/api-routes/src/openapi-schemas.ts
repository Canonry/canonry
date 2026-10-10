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
import { sentimentSummarySchema, sentimentSettingsSchema, sentimentSettingsUpdateSchema, sentimentEvidencePageSchema, sentimentComparisonSchema, sentimentBackfillPreviewSchema, sentimentBackfillRequestSchema, sentimentJobsSchema, sentimentJobSchema } from '@ainyc/canonry-contracts'
import { visibilityReportResponseSchema } from '@ainyc/canonry-contracts'
import { queryTrackingWorkspaceResponseSchema, queryTrackingPreviewRequestSchema, queryTrackingPreviewResponseSchema, queryTrackingCommitRequestSchema, queryTrackingCommitResponseSchema, queryTrackingResultsResponseSchema } from '@ainyc/canonry-contracts'
import {
  agentProvidersResponseDtoSchema,
  agentPromptRequestSchema,
  agentConversationSchema, agentConversationListSchema, agentConversationCreateSchema, agentConversationDeleteSchema,
  apiKeyDtoSchema,
  apiKeyListDtoSchema,
  auditLogEntrySchema,
  integrationSettingsSummaryDtoSchema,
  providerSummaryEntryDtoSchema,
  providerReloadRequestSchema,
  providerReloadResponseDtoSchema,
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
  competitorAliasBlockRequestSchema,
  competitorAliasesRequestSchema,
  competitorAutoAliasDetectionDtoSchema,
  competitorAppendRequestSchema,
  competitorDtoSchema,
  competitorLandscapeResponseSchema,
  contentGapsResponseDtoSchema,
  contentSourcesResponseDtoSchema,
  contentTargetDismissalDtoSchema,
  contentTargetDismissalsResponseDtoSchema,
  contentTargetsResponseDtoSchema,
  conversionTrackingContractSchema,
  conversionTrackingContractWriteRequestSchema,
  conversionTrackingIntegrityReadEnvelopeSchema,
  domainClassificationsResponseDtoSchema,
  recommendationBriefDtoSchema,
  recommendationExplanationDtoSchema,
  discoveryHarvestDtoSchema,
  discoveryPromotePreviewSchema,
  discoveryPromoteResultSchema,
  discoverySessionDetailDtoSchema,
  discoverySessionDtoSchema,
  researchBatchCreateSchema,
  researchBatchSchema,
  researchRunCreateSchema,
  researchRunDetailSchema,
  researchRunListSchema,
  resultsClearRequestSchema,
  resultsClearResponseSchema,
  doctorReportSchema,
  ga4AiReferralDailyDtoSchema,
  ga4AiReferralHistoryEntrySchema,
  ga4SessionHistoryEntrySchema,
  ga4SocialReferralHistoryEntrySchema,
  ga4PropertiesDtoSchema,
  ga4StatusDtoSchema,
  ga4SyncResponseDtoSchema,
  gaAttributionTrendResponseSchema,
  gaMeasurementAnalysisDtoSchema,
  gaSearchLandingPagesResponseSchema,
  gaSocialReferralTrendResponseSchema,
  gaTrafficResponseSchema,
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
  gbpReviewListResponseSchema,
  gbpSummaryDtoSchema,
  googleConnectionDtoSchema,
  googleAdsAccessibleCustomersResponseSchema,
  googleAdsConnectionStatusDtoSchema,
  googleAdsCustomerSelectionRequestSchema,
  conversionTrackingOptionsDtoSchema,
  googleAdsPerformanceDtoSchema,
  googleAdsStoredSnapshotPageSchema,
  googleAdsStoredSnapshotReadEnvelopeSchema,
  googleMarketingDisconnectResponseSchema,
  googleMarketingOAuthConnectRequestSchema,
  googleMarketingOAuthConnectResponseSchema,
  gscCoverageSnapshotDtoSchema,
  gscCoverageSummaryDtoSchema,
  gscDeindexedRowSchema,
  gscPerformanceDailyDtoSchema,
  gscPerformanceResponseDtoSchema,
  gscTopPagesDtoSchema,
  gscQueryTotalsDtoSchema,
  gscDiscoverSitemapsResponseDtoSchema,
  gscSiteListResponseDtoSchema,
  gscSubmitSitemapsResponseDtoSchema,
  gscSitemapListResponseDtoSchema,
  gscUrlInspectionDtoSchema,
  gtmAccountsResponseSchema,
  gtmConnectionStatusDtoSchema,
  gtmContainerListResponseSchema,
  gtmResourceSelectionRequestSchema,
  gtmStoredSnapshotPageSchema,
  gtmStoredSnapshotReadEnvelopeSchema,
  gtmWorkspaceListResponseSchema,
  healthSnapshotDtoSchema,
  indexingRequestResponseDtoSchema,
  keywordDtoSchema,
  keywordGenerateResponseSchema,
  latestProjectRunDtoSchema,
  runAdmissionDtoSchema,
  locationContextSchema,
  measurementDiscoveryRequestSchema,
  measurementDiscoveryResponseSchema,
  measurementDraftApplyAssignmentsRequestSchema,
  measurementDraftApplyGroupMembershipRequestSchema,
  measurementDraftApplyGroupMembershipResponseSchema,
  measurementDraftApplyPairedAssignmentsRequestSchema,
  measurementDraftApplySitemapSelectionRequestSchema,
  measurementDraftAssignmentPageSchema,
  measurementDraftClassifyAssignmentsRequestSchema,
  measurementDraftClearAssignmentsRequestSchema,
  measurementDraftCompilePreviewResponseSchema,
  measurementDraftCreateRequestSchema,
  measurementDraftDiffPreviewResponseSchema,
  measurementDraftDiscardResponseSchema,
  measurementDraftExcludeTargetRequestSchema,
  measurementDraftGroupPageSchema,
  measurementDraftImportSitemapRequestSchema,
  measurementDraftMergeTargetsRequestSchema,
  measurementDraftMutationResponseSchema,
  measurementDraftPinCompetitorRequestSchema,
  measurementDraftPinCompetitorResponseSchema,
  measurementDraftPublishRequestSchema,
  measurementDraftPreviewAssignmentsRequestSchema,
  measurementDraftPreviewAssignmentsResponseSchema,
  measurementDraftPreviewGroupMembershipRequestSchema,
  measurementDraftPreviewGroupMembershipResponseSchema,
  measurementDraftRebindTargetRequestSchema,
  measurementDraftRemoveAssignmentRequestSchema,
  measurementDraftRemoveCompetitorRequestSchema,
  measurementDraftRemoveGroupRequestSchema,
  measurementDraftReplaceAssignmentsRequestSchema,
  measurementDraftRenameTargetRequestSchema,
  measurementChangesResponseSchema,
  measurementDataQualityResponseSchema,
  measurementDraftResponseSchema,
  measurementDraftTargetPageSchema,
  measurementDraftUpsertCompetitorRequestSchema,
  measurementDraftUpsertGroupRequestSchema,
  measurementDraftUpsertMarketRequestSchema,
  measurementDraftUpsertTargetRequestSchema,
  measurementOverviewResponseSchema,
  measurementPortfolioSummaryResponseSchema,
  measurementPlanAuthoringSchema,
  measurementPlanCompilePreviewResponseSchema,
  measurementPlanDeactivateRequestSchema,
  measurementPlanDeactivateResponseSchema,
  measurementPlanDiffPreviewResponseSchema,
  measurementPlanPublishRequestSchema,
  measurementPlanResponseSchema,
  measurementPlanV2PublishResponseSchema,
  measurementPlanVersionResponseSchema,
  measurementPlanVersionsResponseSchema,
  measurementPropertyCompetitorsResponseSchema,
  measurementPropertyEvidenceResponseSchema,
  measurementPropertyQuestionsResponseSchema,
  measurementQuestionResultResponseSchema,
  measurementQuerySetDetailSchema,
  measurementQuerySetListResponseSchema,
  measurementQuerySetUpsertRequestSchema,
  measurementQueryTemplateApplyRequestSchema,
  measurementQueryTemplateApplyResponseSchema,
  measurementQueryTemplateListResponseSchema,
  measurementQueryTemplateSchema,
  measurementQueryTemplateUpsertRequestSchema,
  measurementReportResponseSchema,
  measurementSegmentRetirementResponseSchema,
  measurementSetupResponseSchema,
  notificationDtoSchema,
  onboardingTelemetryEventSchema,
  uiTelemetryEventSchema,
  organicEvidenceDtoSchema,
  projectCreateRequestSchema,
  projectDtoSchema,
  projectDefaultLocationResponseSchema,
  projectUpsertRequestSchema,
  projectConfigSchema,
  projectConfigExportSchema,
  projectOverviewDtoSchema,
  trafficAnalyticsResponseSchema,
  projectSearchResponseSchema,
  resultsExportDtoSchema,
  queryDtoSchema,
  queryGenerateResponseSchema,
  runDetailDtoSchema,
  runCompletenessDtoSchema,
  runFillResponseDtoSchema,
  adsCampaignListResponseSchema,
  adsAccountDtoSchema,
  adsActivateTreeResponseSchema,
  adsActivationGrantResponseSchema,
  adsConnectionStatusDtoSchema,
  adsDeliveryDiagnosticsDtoSchema,
  adsConversionEventSettingListResponseSchema,
  adsConversionPixelListResponseSchema,
  adsDisconnectResponseSchema,
  adsGeoSearchResponseSchema,
  adsInsightsResponseSchema,
  adsLiveDeliveryDtoSchema,
  adsOperationReconcileResponseSchema,
  adsOperationResponseSchema,
  adsSummaryDtoSchema,
  adsSyncResponseSchema,
  adsUnresolvedOperationListResponseSchema,
  runDtoSchema,
  schedulableRunKindSchema,
  calendarRecurrenceSchema,
  scheduleDtoSchema,
  settingsDtoSchema,
  siteAuditLivePageHealthSchema,
  siteAuditScoreSchema,
  siteAuditPagesResponseSchema,
  siteAuditRunProgressSchema,
  siteAuditTrendResponseSchema,
  siteAuditRunResponseSchema,
  siteCrawlDeadLinksResponseSchema,
  siteCrawlGraphResponseSchema,
  siteCrawlInternalLinksResponseSchema,
  siteCrawlNeighborsResponseSchema,
  siteCrawlPageAuditSchema,
  siteCrawlPagesResponseSchema,
  siteCrawlStructureResponseSchema,
  siteCrawlSummarySchema,
  siteHealthChangesResponseSchema,
  siteHealthPathResponseSchema,
  siteHealthScansResponseSchema,
  siteHealthSubgraphResponseSchema,
  snapshotDiffResponseSchema,
  snapshotListResponseSchema,
  snapshotReportSchema,
  snapshotRequestInputSchema,
  sourceBreakdownDtoSchema,
  telemetryEventAcceptedDtoSchema,
  feedbackSubmissionSchema,
  feedbackAcceptedDtoSchema,
  telemetryStatusDtoSchema,
  operationalLogListDtoSchema,
  cloudflareWorkerIngestRequestSchema,
  cloudflareWorkerIngestResponseSchema,
  trafficBackfillResponseSchema,
  trafficConnectCloudflareRequestSchema,
  trafficConnectCloudflareResponseSchema,
  referralAssessmentSchema,
  trafficEventsResponseSchema,
  trafficSourceDetailDtoSchema,
  trafficSourceDtoSchema,
  trafficSourceListResponseSchema,
  trafficStatusResponseSchema,
  trafficSyncResponseSchema,
  authSessionDtoSchema,
  createUserRequestSchema,
  loginRequestSchema,
  userDtoSchema,
  userListDtoSchema,
  visibilityCompareDtoSchema,
  visibilityStatsDtoSchema,
  wordpressAuditPageDtoSchema,
  wordpressBulkMetaResultDtoSchema,
  wordpressDiffDtoSchema,
  wordpressManualAssistDtoSchema,
  wordpressOnboardResultDtoSchema,
  wordpressPageDetailDtoSchema,
  wordpressPageListDtoSchema,
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
  SentimentSummary: sentimentSummarySchema,
  SentimentSettings: sentimentSettingsSchema,
  SentimentSettingsUpdate: sentimentSettingsUpdateSchema,
  SentimentEvidencePage: sentimentEvidencePageSchema,
  SentimentComparison: sentimentComparisonSchema,
  SentimentBackfillPreview: sentimentBackfillPreviewSchema,
  SentimentBackfillRequest: sentimentBackfillRequestSchema,
  SentimentJobs: sentimentJobsSchema,
  SentimentJob: sentimentJobSchema,
  VisibilityReportResponse: visibilityReportResponseSchema,
  QueryTrackingWorkspaceResponse: queryTrackingWorkspaceResponseSchema,
  QueryTrackingPreviewRequest: queryTrackingPreviewRequestSchema,
  QueryTrackingPreviewResponse: queryTrackingPreviewResponseSchema,
  QueryTrackingCommitRequest: queryTrackingCommitRequestSchema,
  QueryTrackingCommitResponse: queryTrackingCommitResponseSchema,
  QueryTrackingResultsResponse: queryTrackingResultsResponseSchema,
  AgentPromptRequest: agentPromptRequestSchema,
  AgentConversation: agentConversationSchema,
  AgentConversationList: agentConversationListSchema,
  AgentConversationCreate: agentConversationCreateSchema,
  AgentConversationDelete: agentConversationDeleteSchema,
  AgentProvidersResponseDto: agentProvidersResponseDtoSchema,
  AdsAccountDto: adsAccountDtoSchema,
  AdsActivateTreeResponse: adsActivateTreeResponseSchema,
  AdsActivationGrantResponse: adsActivationGrantResponseSchema,
  AdsCampaignListResponse: adsCampaignListResponseSchema,
  AdsConnectionStatusDto: adsConnectionStatusDtoSchema,
  AdsDeliveryDiagnosticsDto: adsDeliveryDiagnosticsDtoSchema,
  AdsConversionEventSettingListResponse: adsConversionEventSettingListResponseSchema,
  AdsConversionPixelListResponse: adsConversionPixelListResponseSchema,
  AdsDisconnectResponse: adsDisconnectResponseSchema,
  AdsGeoSearchResponse: adsGeoSearchResponseSchema,
  AdsInsightsResponse: adsInsightsResponseSchema,
  AdsLiveDeliveryDto: adsLiveDeliveryDtoSchema,
  AdsOperationReconcileResponse: adsOperationReconcileResponseSchema,
  AdsOperationResponse: adsOperationResponseSchema,
  AdsSummaryDto: adsSummaryDtoSchema,
  AdsSyncResponse: adsSyncResponseSchema,
  AdsUnresolvedOperationListResponse: adsUnresolvedOperationListResponseSchema,
  ApiKeyDto: apiKeyDtoSchema,
  ApiKeyListDto: apiKeyListDtoSchema,
  AuditLogEntry: auditLogEntrySchema,
  AuthSessionDto: authSessionDtoSchema,
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
  CompetitorAliasBlockRequest: competitorAliasBlockRequestSchema,
  CompetitorAliasesRequest: competitorAliasesRequestSchema,
  CompetitorAppendRequest: competitorAppendRequestSchema,
  CompetitorAutoAliasDetectionDto: competitorAutoAliasDetectionDtoSchema,
  CompetitorDto: competitorDtoSchema,
  CompetitorLandscapeResponse: competitorLandscapeResponseSchema,
  ContentGapsResponseDto: contentGapsResponseDtoSchema,
  ContentSourcesResponseDto: contentSourcesResponseDtoSchema,
  ContentTargetDismissalDto: contentTargetDismissalDtoSchema,
  ContentTargetDismissalsResponseDto: contentTargetDismissalsResponseDtoSchema,
  ContentTargetsResponseDto: contentTargetsResponseDtoSchema,
  ConversionTrackingContract: conversionTrackingContractSchema,
  ConversionTrackingContractWriteRequest: conversionTrackingContractWriteRequestSchema,
  ConversionTrackingIntegrityReadEnvelope: conversionTrackingIntegrityReadEnvelopeSchema,
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
  ResearchBatchCreate: researchBatchCreateSchema,
  ResearchBatchDto: researchBatchSchema,
  ResearchRunCreate: researchRunCreateSchema,
  ResearchRunDetailDto: researchRunDetailSchema,
  ResearchRunListDto: researchRunListSchema,
  ResultsClearRequest: resultsClearRequestSchema,
  ResultsClearResponse: resultsClearResponseSchema,
  DoctorReportDto: doctorReportSchema,
  GA4AiReferralDailyDto: ga4AiReferralDailyDtoSchema,
  GA4AiReferralHistoryEntry: ga4AiReferralHistoryEntrySchema,
  GA4MeasurementAnalysisDto: gaMeasurementAnalysisDtoSchema,
  GA4SessionHistoryEntry: ga4SessionHistoryEntrySchema,
  GA4SocialReferralHistoryEntry: ga4SocialReferralHistoryEntrySchema,
  GA4PropertiesDto: ga4PropertiesDtoSchema,
  GA4StatusDto: ga4StatusDtoSchema,
  GA4SyncResponseDto: ga4SyncResponseDtoSchema,
  GaAttributionTrendResponse: gaAttributionTrendResponseSchema,
  GaSearchLandingPagesResponse: gaSearchLandingPagesResponseSchema,
  GaSocialReferralTrendResponse: gaSocialReferralTrendResponseSchema,
  GaTrafficResponse: gaTrafficResponseSchema,
  GbpAccountListResponse: gbpAccountListResponseSchema,
  GbpDailyMetricListResponse: gbpDailyMetricListResponseSchema,
  GbpKeywordImpressionListResponse: gbpKeywordImpressionListResponseSchema,
  GbpLocationDto: gbpLocationDtoSchema,
  GbpLocationListResponse: gbpLocationListResponseSchema,
  GbpLodgingListResponse: gbpLodgingListResponseSchema,
  GbpAttributesListResponse: gbpAttributesListResponseSchema,
  GbpPlaceActionListResponse: gbpPlaceActionListResponseSchema,
  GbpPlaceDetailsListResponse: gbpPlaceDetailsListResponseSchema,
  GbpReviewListResponse: gbpReviewListResponseSchema,
  GbpSummaryDto: gbpSummaryDtoSchema,
  GbpSyncResponse: gbpSyncResponseSchema,
  GoogleAdsAccessibleCustomersResponse: googleAdsAccessibleCustomersResponseSchema,
  GoogleAdsConnectionStatusDto: googleAdsConnectionStatusDtoSchema,
  GoogleAdsCustomerSelectionRequest: googleAdsCustomerSelectionRequestSchema,
  ConversionTrackingOptionsDto: conversionTrackingOptionsDtoSchema,
  GoogleAdsPerformanceDto: googleAdsPerformanceDtoSchema,
  GoogleAdsStoredSnapshotPage: googleAdsStoredSnapshotPageSchema,
  GoogleAdsStoredSnapshotReadEnvelope: googleAdsStoredSnapshotReadEnvelopeSchema,
  GoogleConnectionDto: googleConnectionDtoSchema,
  GoogleMarketingDisconnectResponse: googleMarketingDisconnectResponseSchema,
  GoogleMarketingOAuthConnectRequest: googleMarketingOAuthConnectRequestSchema,
  GoogleMarketingOAuthConnectResponse: googleMarketingOAuthConnectResponseSchema,
  GscCoverageSnapshotDto: gscCoverageSnapshotDtoSchema,
  GscCoverageSummaryDto: gscCoverageSummaryDtoSchema,
  GscDeindexedRowDto: gscDeindexedRowSchema,
  GscPerformanceDailyDto: gscPerformanceDailyDtoSchema,
  GscPerformanceResponseDto: gscPerformanceResponseDtoSchema,
  GscTopPagesDto: gscTopPagesDtoSchema,
  GscQueryTotalsDto: gscQueryTotalsDtoSchema,
  GscDiscoverSitemapsResponseDto: gscDiscoverSitemapsResponseDtoSchema,
  GscSiteListResponseDto: gscSiteListResponseDtoSchema,
  GscSubmitSitemapsResponseDto: gscSubmitSitemapsResponseDtoSchema,
  GscSitemapListResponseDto: gscSitemapListResponseDtoSchema,
  GscUrlInspectionDto: gscUrlInspectionDtoSchema,
  GtmAccountsResponse: gtmAccountsResponseSchema,
  GtmConnectionStatusDto: gtmConnectionStatusDtoSchema,
  GtmContainerListResponse: gtmContainerListResponseSchema,
  GtmResourceSelectionRequest: gtmResourceSelectionRequestSchema,
  GtmStoredSnapshotPage: gtmStoredSnapshotPageSchema,
  GtmStoredSnapshotReadEnvelope: gtmStoredSnapshotReadEnvelopeSchema,
  GtmWorkspaceListResponse: gtmWorkspaceListResponseSchema,
  HealthSnapshotDto: healthSnapshotDtoSchema,
  IndexingRequestResponseDto: indexingRequestResponseDtoSchema,
  IntegrationSettingsSummaryDto: integrationSettingsSummaryDtoSchema,
  KeywordDto: keywordDtoSchema,
  KeywordGenerateResponse: keywordGenerateResponseSchema,
  LatestProjectRunDto: latestProjectRunDtoSchema,
  RunAdmissionDto: runAdmissionDtoSchema,
  LocationContext: locationContextSchema,
  MeasurementDiscoveryRequest: measurementDiscoveryRequestSchema,
  MeasurementDiscoveryResponse: measurementDiscoveryResponseSchema,
  MeasurementDraftApplyAssignmentsRequest: measurementDraftApplyAssignmentsRequestSchema,
  MeasurementDraftApplyGroupMembershipRequest: measurementDraftApplyGroupMembershipRequestSchema,
  MeasurementDraftApplyGroupMembershipResponse: measurementDraftApplyGroupMembershipResponseSchema,
  MeasurementDraftApplyPairedAssignmentsRequest: measurementDraftApplyPairedAssignmentsRequestSchema,
  MeasurementDraftApplySitemapSelectionRequest: measurementDraftApplySitemapSelectionRequestSchema,
  MeasurementDraftAssignmentPage: measurementDraftAssignmentPageSchema,
  MeasurementDraftClassifyAssignmentsRequest: measurementDraftClassifyAssignmentsRequestSchema,
  MeasurementDraftClearAssignmentsRequest: measurementDraftClearAssignmentsRequestSchema,
  MeasurementDraftCompilePreviewResponse: measurementDraftCompilePreviewResponseSchema,
  MeasurementDraftCreateRequest: measurementDraftCreateRequestSchema,
  MeasurementDraftDiffPreviewResponse: measurementDraftDiffPreviewResponseSchema,
  MeasurementDraftDiscardResponse: measurementDraftDiscardResponseSchema,
  MeasurementDraftExcludeTargetRequest: measurementDraftExcludeTargetRequestSchema,
  MeasurementDraftGroupPage: measurementDraftGroupPageSchema,
  MeasurementDraftImportSitemapRequest: measurementDraftImportSitemapRequestSchema,
  MeasurementDraftMergeTargetsRequest: measurementDraftMergeTargetsRequestSchema,
  MeasurementDraftMutationResponse: measurementDraftMutationResponseSchema,
  MeasurementDraftPinCompetitorRequest: measurementDraftPinCompetitorRequestSchema,
  MeasurementDraftPinCompetitorResponse: measurementDraftPinCompetitorResponseSchema,
  MeasurementDraftPublishRequest: measurementDraftPublishRequestSchema,
  MeasurementDraftPreviewAssignmentsRequest: measurementDraftPreviewAssignmentsRequestSchema,
  MeasurementDraftPreviewAssignmentsResponse: measurementDraftPreviewAssignmentsResponseSchema,
  MeasurementDraftPreviewGroupMembershipRequest: measurementDraftPreviewGroupMembershipRequestSchema,
  MeasurementDraftPreviewGroupMembershipResponse: measurementDraftPreviewGroupMembershipResponseSchema,
  MeasurementDraftRebindTargetRequest: measurementDraftRebindTargetRequestSchema,
  MeasurementDraftRemoveAssignmentRequest: measurementDraftRemoveAssignmentRequestSchema,
  MeasurementDraftRemoveCompetitorRequest: measurementDraftRemoveCompetitorRequestSchema,
  MeasurementDraftRemoveGroupRequest: measurementDraftRemoveGroupRequestSchema,
  MeasurementDraftReplaceAssignmentsRequest: measurementDraftReplaceAssignmentsRequestSchema,
  MeasurementDraftRenameTargetRequest: measurementDraftRenameTargetRequestSchema,
  MeasurementChangesResponse: measurementChangesResponseSchema,
  MeasurementDataQualityResponse: measurementDataQualityResponseSchema,
  MeasurementDraftResponse: measurementDraftResponseSchema,
  MeasurementDraftTargetPage: measurementDraftTargetPageSchema,
  MeasurementDraftUpsertCompetitorRequest: measurementDraftUpsertCompetitorRequestSchema,
  MeasurementDraftUpsertGroupRequest: measurementDraftUpsertGroupRequestSchema,
  MeasurementDraftUpsertMarketRequest: measurementDraftUpsertMarketRequestSchema,
  MeasurementDraftUpsertTargetRequest: measurementDraftUpsertTargetRequestSchema,
  MeasurementOverviewResponse: measurementOverviewResponseSchema,
  MeasurementPortfolioSummaryResponse: measurementPortfolioSummaryResponseSchema,
  MeasurementPlanCompilePreviewResponse: measurementPlanCompilePreviewResponseSchema,
  MeasurementPlanDeactivateRequest: measurementPlanDeactivateRequestSchema,
  MeasurementPlanDeactivateResponse: measurementPlanDeactivateResponseSchema,
  MeasurementPlanDiffPreviewResponse: measurementPlanDiffPreviewResponseSchema,
  MeasurementPlanInput: measurementPlanAuthoringSchema,
  MeasurementPlanPublishRequest: measurementPlanPublishRequestSchema,
  MeasurementPlanResponse: measurementPlanResponseSchema,
  MeasurementPlanV2PublishResponse: measurementPlanV2PublishResponseSchema,
  MeasurementPlanVersionResponse: measurementPlanVersionResponseSchema,
  MeasurementPlanVersionsResponse: measurementPlanVersionsResponseSchema,
  MeasurementPropertyCompetitorsResponse: measurementPropertyCompetitorsResponseSchema,
  MeasurementPropertyEvidenceResponse: measurementPropertyEvidenceResponseSchema,
  MeasurementPropertyQuestionsResponse: measurementPropertyQuestionsResponseSchema,
  MeasurementQuestionResultResponse: measurementQuestionResultResponseSchema,
  MeasurementQuerySetDetail: measurementQuerySetDetailSchema,
  MeasurementQuerySetListResponse: measurementQuerySetListResponseSchema,
  MeasurementQuerySetUpsertRequest: measurementQuerySetUpsertRequestSchema,
  MeasurementQueryTemplateApplyRequest: measurementQueryTemplateApplyRequestSchema,
  MeasurementQueryTemplateApplyResponse: measurementQueryTemplateApplyResponseSchema,
  MeasurementQueryTemplateDto: measurementQueryTemplateSchema,
  MeasurementQueryTemplateListResponse: measurementQueryTemplateListResponseSchema,
  MeasurementQueryTemplateUpsertRequest: measurementQueryTemplateUpsertRequestSchema,
  MeasurementReportResponse: measurementReportResponseSchema,
  MeasurementSegmentRetirementResponse: measurementSegmentRetirementResponseSchema,
  MeasurementSetupResponse: measurementSetupResponseSchema,
  NotificationDto: notificationDtoSchema,
  OnboardingTelemetryEvent: onboardingTelemetryEventSchema,
  UiTelemetryEvent: uiTelemetryEventSchema,
  OrganicEvidenceDto: organicEvidenceDtoSchema,
  ProjectCreateRequest: projectCreateRequestSchema,
  ProjectDto: projectDtoSchema,
  ProjectDefaultLocationResponse: projectDefaultLocationResponseSchema,
  ProjectUpsertRequest: projectUpsertRequestSchema,
  ProjectConfig: projectConfigSchema,
  ProjectConfigExport: projectConfigExportSchema,
  ProjectOverviewDto: projectOverviewDtoSchema,
  TrafficAnalyticsResponse: trafficAnalyticsResponseSchema,
  ProjectSearchResponseDto: projectSearchResponseSchema,
  ProviderReloadRequest: providerReloadRequestSchema,
  ProviderReloadResponseDto: providerReloadResponseDtoSchema,
  ProviderSummaryEntryDto: providerSummaryEntryDtoSchema,
  QueryDto: queryDtoSchema,
  QueryGenerateResponse: queryGenerateResponseSchema,
  ReferralAssessment: referralAssessmentSchema,
  ResultsExportDto: resultsExportDtoSchema,
  RunCompletenessDto: runCompletenessDtoSchema,
  RunDetailDto: runDetailDtoSchema,
  RunFillResponseDto: runFillResponseDtoSchema,
  RunDto: runDtoSchema,
  SchedulableRunKind: schedulableRunKindSchema,
  CalendarRecurrence: calendarRecurrenceSchema,
  ScheduleDto: scheduleDtoSchema,
  SettingsDto: settingsDtoSchema,
  SiteAuditLivePageHealthDto: siteAuditLivePageHealthSchema,
  SiteAuditPagesResponseDto: siteAuditPagesResponseSchema,
  SiteAuditRunProgressDto: siteAuditRunProgressSchema,
  SiteAuditRunResponseDto: siteAuditRunResponseSchema,
  SiteAuditScoreDto: siteAuditScoreSchema,
  SiteAuditTrendResponseDto: siteAuditTrendResponseSchema,
  SiteCrawlDeadLinksResponseDto: siteCrawlDeadLinksResponseSchema,
  SiteCrawlGraphResponseDto: siteCrawlGraphResponseSchema,
  SiteCrawlInternalLinksResponseDto: siteCrawlInternalLinksResponseSchema,
  SiteCrawlNeighborsResponseDto: siteCrawlNeighborsResponseSchema,
  SiteCrawlPageAuditDto: siteCrawlPageAuditSchema,
  SiteCrawlPagesResponseDto: siteCrawlPagesResponseSchema,
  SiteCrawlStructureResponseDto: siteCrawlStructureResponseSchema,
  SiteCrawlSummaryDto: siteCrawlSummarySchema,
  SiteHealthChangesResponseDto: siteHealthChangesResponseSchema,
  SiteHealthPathResponseDto: siteHealthPathResponseSchema,
  SiteHealthScansResponseDto: siteHealthScansResponseSchema,
  SiteHealthSubgraphResponseDto: siteHealthSubgraphResponseSchema,
  SnapshotDiffResponse: snapshotDiffResponseSchema,
  SnapshotListResponse: snapshotListResponseSchema,
  SnapshotReportDto: snapshotReportSchema,
  // The API accepts legacy phrases, but the public contract advertises queries.
  SnapshotRequest: z.object(snapshotRequestInputSchema.shape).omit({ phrases: true }),
  SourceBreakdownDto: sourceBreakdownDtoSchema,
  TelemetryEventAcceptedDto: telemetryEventAcceptedDtoSchema,
  FeedbackSubmission: feedbackSubmissionSchema,
  FeedbackAcceptedDto: feedbackAcceptedDtoSchema,
  TelemetryStatusDto: telemetryStatusDtoSchema,
  OperationalLogListDto: operationalLogListDtoSchema,
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
  UserDto: userDtoSchema,
  UserListDto: userListDtoSchema,
  CreateUserRequest: createUserRequestSchema,
  LoginRequest: loginRequestSchema,
  VisibilityCompareDto: visibilityCompareDtoSchema,
  VisibilityStatsDto: visibilityStatsDtoSchema,
  WordpressAuditPageDto: wordpressAuditPageDtoSchema,
  WordpressBulkMetaResultDto: wordpressBulkMetaResultDtoSchema,
  WordpressDiffDto: wordpressDiffDtoSchema,
  WordpressManualAssistDto: wordpressManualAssistDtoSchema,
  WordpressOnboardResultDto: wordpressOnboardResultDtoSchema,
  WordpressPageDetailDto: wordpressPageDetailDtoSchema,
  WordpressPageListDto: wordpressPageListDtoSchema,
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
 * OpenAPI 3.0.3 admits `null` into an `enum` only when `null` is one of the
 * listed values; `nullable: true` beside the `enum` does not widen it. Zod's
 * `toJSONSchema` emits `z.enum([...]).nullable()` as `{ type, enum,
 * nullable: true }`, so codegen dropped the `| null` (e.g.
 * `Ga4StatusDto.authMethod`). Append `null` to every such `enum` so the
 * generated types keep it. A nullable `$ref` is left alone: its enum lives in
 * the shared component, which is not nullable everywhere.
 */
function addNullToNullableEnums(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) addNullToNullableEnums(item)
    return
  }
  if (node === null || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  if (record.nullable === true && Array.isArray(record.enum)) {
    const values: unknown[] = record.enum
    if (!values.includes(null)) record.enum = [...values, null]
  }
  for (const value of Object.values(record)) addNullToNullableEnums(value)
}

/**
 * Schemas documented in their input form. `ProjectConfig` is the `POST /apply`
 * body, which may leave any defaulted field out: apply fills the defaults when
 * it parses the document. The output form would mark every defaulted field
 * (`providerModels`, `autoExtractBacklinks`, ...) required. `GET /export`
 * writes most of them, so it has its own `ProjectConfigExport`.
 */
const INPUT_FORM_SCHEMAS: ReadonlySet<string> = new Set<RegisteredSchemaName>(['ProjectConfig'])

/**
 * Convert every registered schema to its OpenAPI 3.0 JSON Schema. Called once
 * during spec build, embedded as `components.schemas` in the OpenAPI doc.
 */
export function buildComponentSchemas(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, schema] of Object.entries(SCHEMA_TABLE) as [string, ZodType][]) {
    const io = INPUT_FORM_SCHEMAS.has(name) ? 'input' : 'output'
    const json = z.toJSONSchema(schema, { target: 'openapi-3.0', io }) as Record<string, unknown>
    addNullToNullableEnums(json)
    out[name] = json
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
