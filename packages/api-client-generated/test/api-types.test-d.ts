import { expectTypeOf } from 'vitest'
import type {
  AdsCampaignListResponse,
  AdsOperationReconcileResponse,
  AdsUnresolvedOperationListResponse,
  GetApiV1ProjectsByNameMeasurementReportData,
  GetApiV1ProjectsByNameTechnicalAeoGraphData,
  GetApiV1ProjectsByNameTechnicalAeoChangesData,
  GetApiV1ProjectsByNameTechnicalAeoPathData,
  GetApiV1ProjectsByNameTechnicalAeoRunsByRunIdPageHealthPreviewData,
  GetApiV1ProjectsByNameTechnicalAeoSubgraphData,
  GetApiV1ProjectsByNameSearchResponse,
  MeasurementDiscoveryRequest,
  MeasurementDiscoveryResponse,
  MeasurementReportResponse,
  PostApiV1ProjectsByNameMeasurementDiscoveryData,
  ResearchBatchCreate,
} from '../src/index.js'

// Retains nullable ads bidding and billing values in generated response types
type Campaign = AdsCampaignListResponse['campaigns'][number]
type AdGroup = Campaign['adGroups'][number]

expectTypeOf<Campaign['biddingType']>()
  .toEqualTypeOf<'impressions' | 'clicks' | null | undefined>()
expectTypeOf<AdGroup['billingEventType']>()
  .toEqualTypeOf<'impression' | 'click' | null | undefined>()

// Generates the typed ads recovery operation surface
type Operation = AdsUnresolvedOperationListResponse['operations'][number]

expectTypeOf<Operation['state']>()
  .toEqualTypeOf<'pending' | 'reconciling' | 'succeeded' | 'failed' | 'unknown'>()
expectTypeOf<Operation['entityType']>()
  .toEqualTypeOf<'file' | 'campaign' | 'ad_group' | 'ad' | null>()
expectTypeOf<Operation['reconcileStrategy']>()
  .toEqualTypeOf<'known_entity' | 'create_fingerprint' | 'manual_only' | null>()
expectTypeOf<AdsOperationReconcileResponse['resolved']>().toEqualTypeOf<boolean>()

// Generates cited URL search hits
type SnapshotHit = Extract<
  GetApiV1ProjectsByNameSearchResponse['hits'][number],
  { kind: 'snapshot' }
>

expectTypeOf<SnapshotHit['matchedField']>().toEqualTypeOf<
  'answerText' | 'citedDomains' | 'citedUrls' | 'searchQueries' | 'query'
>()

// Generates the typed measurement discovery and report adapter surface
expectTypeOf<PostApiV1ProjectsByNameMeasurementDiscoveryData['body']>()
  .toEqualTypeOf<MeasurementDiscoveryRequest>()
expectTypeOf<GetApiV1ProjectsByNameMeasurementReportData['query']>()
  .toEqualTypeOf<{ revision: number; runId?: string; queryClass?: 'non-brand' | 'branded' | 'all' }>()
expectTypeOf<MeasurementDiscoveryResponse['proposed'][number]['classification']>()
  .toEqualTypeOf<'proposed'>()
expectTypeOf<MeasurementReportResponse['groups'][number]['targetIds']>()
  .toEqualTypeOf<string[]>()

expectTypeOf<NonNullable<ResearchBatchCreate['runs'][number]['scope']>['expectedPlanRevision']>()
  .toEqualTypeOf<number>()

expectTypeOf<GetApiV1ProjectsByNameTechnicalAeoGraphData['query']>()
  .toEqualTypeOf<{ runId?: string; maxNodes?: number; maxEdges?: number; linkKind?: 'all' | 'content' | 'template' } | undefined>()

expectTypeOf<GetApiV1ProjectsByNameTechnicalAeoSubgraphData['query']>()
  .toEqualTypeOf<{ runId?: string; nodeKey?: string; url?: string; hops?: number; maxNodes?: number; maxEdges?: number } | undefined>()
expectTypeOf<GetApiV1ProjectsByNameTechnicalAeoPathData['query']>()
  .toEqualTypeOf<{ runId?: string; fromNodeKey?: string; fromUrl?: string; toNodeKey?: string; toUrl?: string; maxDepth?: number } | undefined>()
expectTypeOf<GetApiV1ProjectsByNameTechnicalAeoChangesData['query']>()
  .toEqualTypeOf<{
    fromRunId?: string
    toRunId?: string
    scope?: 'all' | 'pages' | 'links'
    change?: 'all' | 'added' | 'removed' | 'changed'
    cursor?: string
    limit?: number
  } | undefined>()

expectTypeOf<GetApiV1ProjectsByNameTechnicalAeoRunsByRunIdPageHealthPreviewData['path']>()
  .toEqualTypeOf<{ name: string; runId: string }>()
