import { z } from 'zod'
import { fraction } from './ratio-unit.js'

const opaqueIdSchema = z.string().trim().min(1)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i)

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export const calendarDateSchema = z.string().refine(isCalendarDate, {
  message: 'Expected a calendar date as YYYY-MM-DD.',
})

function inclusiveCalendarDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  return Math.floor((end - start) / 86_400_000) + 1
}

/** Read-only connection state. Credentials remain in private config, never this DTO. */
export const googleAdsConnectionStateSchema = z.enum([
  'not-connected',
  'selection-required',
  'connected',
  'stale',
])
export type GoogleAdsConnectionState = z.infer<typeof googleAdsConnectionStateSchema>
export const GoogleAdsConnectionStates = googleAdsConnectionStateSchema.enum

/** Normalized customer state. Unknown upstream values map to `unknown`. */
export const googleAdsCustomerStatusSchema = z.enum([
  'enabled',
  'suspended',
  'closed',
  'canceled',
  'unspecified',
  'unknown',
])
export type GoogleAdsCustomerStatus = z.infer<typeof googleAdsCustomerStatusSchema>
export const GoogleAdsCustomerStatuses = googleAdsCustomerStatusSchema.enum

export const googleAdsCampaignStatusSchema = z.enum([
  'enabled',
  'paused',
  'removed',
  'unknown',
])
export type GoogleAdsCampaignStatus = z.infer<typeof googleAdsCampaignStatusSchema>
export const GoogleAdsCampaignStatuses = googleAdsCampaignStatusSchema.enum

export const googleAdsConversionActionStatusSchema = z.enum([
  'enabled',
  'hidden',
  'removed',
  'unknown',
])
export type GoogleAdsConversionActionStatus = z.infer<typeof googleAdsConversionActionStatusSchema>
export const GoogleAdsConversionActionStatuses = googleAdsConversionActionStatusSchema.enum

/** Which configured Google Ads goal set a campaign inherits. */
export const googleAdsGoalConfigurationLevelSchema = z.enum(['customer', 'campaign'])
export type GoogleAdsGoalConfigurationLevel = z.infer<typeof googleAdsGoalConfigurationLevelSchema>
export const GoogleAdsGoalConfigurationLevels = googleAdsGoalConfigurationLevelSchema.enum

/** The source of one campaign's effective goal edge. */
export const googleAdsEffectiveGoalSourceSchema = z.enum([
  'customer-goal',
  'campaign-goal',
  'custom-goal',
])
export type GoogleAdsEffectiveGoalSource = z.infer<typeof googleAdsEffectiveGoalSourceSchema>
export const GoogleAdsEffectiveGoalSources = googleAdsEffectiveGoalSourceSchema.enum

/** The user-selected manager/customer context for every Google Ads read. */
export const googleAdsCustomerSelectionDtoSchema = z.object({
  /** Optional manager account used as the Google Ads API login customer. */
  loginCustomerId: opaqueIdSchema.nullable(),
  /** Account whose campaigns, goals, and metrics Canonry reads. */
  customerId: opaqueIdSchema.nullable(),
  selectedAt: z.string().nullable(),
}).strict()
export type GoogleAdsCustomerSelectionDto = z.infer<typeof googleAdsCustomerSelectionDtoSchema>

/** Secret-free, project-local connection metadata. */
export const googleAdsConnectionMetadataDtoSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  scopes: z.array(z.string()).default([]),
  selection: googleAdsCustomerSelectionDtoSchema,
  lastValidatedAt: z.string().nullable(),
  lastInventorySnapshotAt: z.string().nullable(),
  lastMetricsSnapshotAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()
export type GoogleAdsConnectionMetadataDto = z.infer<typeof googleAdsConnectionMetadataDtoSchema>

/** One customer reachable through the authorized Google Ads principal. */
export const googleAdsAccessibleCustomerDtoSchema = z.object({
  resourceName: opaqueIdSchema,
  customerId: opaqueIdSchema,
  parentCustomerId: opaqueIdSchema.nullable(),
  descriptiveName: z.string().nullable(),
  currencyCode: z.string().nullable(),
  timeZone: z.string().nullable(),
  manager: z.boolean(),
  hidden: z.boolean(),
  testAccount: z.boolean(),
  level: z.number().int().nonnegative(),
  status: googleAdsCustomerStatusSchema,
}).strict()
export type GoogleAdsAccessibleCustomerDto = z.infer<typeof googleAdsAccessibleCustomerDtoSchema>

export const googleAdsAccessibleCustomersResponseSchema = z.object({
  customers: z.array(googleAdsAccessibleCustomerDtoSchema),
  totalAccessible: z.number().int().nonnegative(),
  truncated: z.boolean(),
  selection: googleAdsCustomerSelectionDtoSchema,
  fetchedAt: z.string(),
}).strict()
export type GoogleAdsAccessibleCustomersResponse = z.infer<typeof googleAdsAccessibleCustomersResponseSchema>

/** A connection response is deliberately discriminated so a disconnected state cannot carry stale account data. */
export const googleAdsConnectionStatusDtoSchema = z.discriminatedUnion('status', [
  z.object({
    connected: z.literal(false),
    status: z.literal(GoogleAdsConnectionStates['not-connected']),
    connection: z.null(),
    selectedCustomer: z.null(),
  }).strict(),
  z.object({
    connected: z.literal(true),
    status: z.literal(GoogleAdsConnectionStates['selection-required']),
    connection: googleAdsConnectionMetadataDtoSchema,
    selectedCustomer: z.null(),
  }).strict(),
  z.object({
    connected: z.literal(true),
    status: z.literal(GoogleAdsConnectionStates.connected),
    connection: googleAdsConnectionMetadataDtoSchema,
    selectedCustomer: googleAdsAccessibleCustomerDtoSchema,
  }).strict(),
  z.object({
    connected: z.literal(true),
    status: z.literal(GoogleAdsConnectionStates.stale),
    connection: googleAdsConnectionMetadataDtoSchema,
    selectedCustomer: googleAdsAccessibleCustomerDtoSchema,
  }).strict(),
])
export type GoogleAdsConnectionStatusDto = z.infer<typeof googleAdsConnectionStatusDtoSchema>

export const googleAdsCampaignDtoSchema = z.object({
  id: opaqueIdSchema,
  resourceName: opaqueIdSchema,
  name: z.string(),
  status: googleAdsCampaignStatusSchema,
  advertisingChannelType: z.string().nullable(),
  biddingStrategyType: z.string().nullable(),
}).strict()
export type GoogleAdsCampaignDto = z.infer<typeof googleAdsCampaignDtoSchema>

/**
 * A conversion action's `primaryForGoal` is deliberately separate from goal
 * biddability. A primary action is not automatically in every campaign's
 * effective bidding goal.
 */
export const googleAdsConversionActionDtoSchema = z.object({
  id: opaqueIdSchema,
  resourceName: opaqueIdSchema,
  name: z.string(),
  status: googleAdsConversionActionStatusSchema,
  category: z.string(),
  origin: z.string(),
  primaryForGoal: z.boolean(),
  includeInConversionsMetric: z.boolean(),
}).strict()
export type GoogleAdsConversionActionDto = z.infer<typeof googleAdsConversionActionDtoSchema>

export const googleAdsCustomerConversionGoalDtoSchema = z.object({
  category: z.string(),
  origin: z.string(),
  biddable: z.boolean(),
}).strict()
export type GoogleAdsCustomerConversionGoalDto = z.infer<typeof googleAdsCustomerConversionGoalDtoSchema>

export const googleAdsCampaignConversionGoalDtoSchema = z.object({
  campaignId: opaqueIdSchema,
  category: z.string(),
  origin: z.string(),
  biddable: z.boolean(),
}).strict()
export type GoogleAdsCampaignConversionGoalDto = z.infer<typeof googleAdsCampaignConversionGoalDtoSchema>

/** A custom goal binds actions directly instead of via category/origin. */
export const googleAdsCustomConversionGoalDtoSchema = z.object({
  id: opaqueIdSchema,
  name: z.string(),
  conversionActionIds: z.array(opaqueIdSchema),
}).strict()
export type GoogleAdsCustomConversionGoalDto = z.infer<typeof googleAdsCustomConversionGoalDtoSchema>

export const googleAdsCampaignGoalConfigurationDtoSchema = z.object({
  campaignId: opaqueIdSchema,
  goalConfigLevel: googleAdsGoalConfigurationLevelSchema,
  /** Non-null means this campaign optimizes the selected custom action set. */
  customGoalId: opaqueIdSchema.nullable(),
}).strict()
export type GoogleAdsCampaignGoalConfigurationDto = z.infer<typeof googleAdsCampaignGoalConfigurationDtoSchema>

/** Full, bounded-at-the-reader inventory used to derive effective campaign goals. */
export const googleAdsInventoryDtoSchema = z.object({
  customerId: opaqueIdSchema,
  fetchedAt: z.string(),
  campaigns: z.array(googleAdsCampaignDtoSchema),
  conversionActions: z.array(googleAdsConversionActionDtoSchema),
  customerConversionGoals: z.array(googleAdsCustomerConversionGoalDtoSchema),
  campaignConversionGoals: z.array(googleAdsCampaignConversionGoalDtoSchema),
  /** Absent legacy evidence is conservatively treated as incomplete. */
  campaignConversionGoalsComplete: z.boolean().optional(),
  customConversionGoals: z.array(googleAdsCustomConversionGoalDtoSchema),
  campaignGoalConfigurations: z.array(googleAdsCampaignGoalConfigurationDtoSchema),
}).strict()
export type GoogleAdsInventoryDto = z.infer<typeof googleAdsInventoryDtoSchema>

export const googleAdsEffectiveGoalDtoSchema = z.object({
  source: googleAdsEffectiveGoalSourceSchema,
  category: z.string().nullable(),
  origin: z.string().nullable(),
  customGoalId: opaqueIdSchema.nullable(),
  /** Null is retained for a custom goal when the provider does not expose a per-goal flag. */
  biddable: z.boolean().nullable(),
  conversionActionIds: z.array(opaqueIdSchema),
  primaryConversionActionIds: z.array(opaqueIdSchema),
  secondaryConversionActionIds: z.array(opaqueIdSchema),
  missingConversionActionIds: z.array(opaqueIdSchema),
}).strict()
export type GoogleAdsEffectiveGoalDto = z.infer<typeof googleAdsEffectiveGoalDtoSchema>

export const googleAdsEffectiveCampaignGoalDtoSchema = z.object({
  campaignId: opaqueIdSchema,
  goalConfigLevel: googleAdsGoalConfigurationLevelSchema,
  customGoalId: opaqueIdSchema.nullable(),
  missingCustomGoalId: opaqueIdSchema.nullable(),
  goals: z.array(googleAdsEffectiveGoalDtoSchema),
}).strict()
export type GoogleAdsEffectiveCampaignGoalDto = z.infer<typeof googleAdsEffectiveCampaignGoalDtoSchema>

export const googleAdsEffectiveGoalGraphDtoSchema = z.object({
  customerId: opaqueIdSchema,
  derivedAt: z.string(),
  campaigns: z.array(googleAdsEffectiveCampaignGoalDtoSchema),
}).strict()
export type GoogleAdsEffectiveGoalGraphDto = z.infer<typeof googleAdsEffectiveGoalGraphDtoSchema>

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right))
}

function actionMembership(actionIds: readonly string[], actionsById: ReadonlyMap<string, GoogleAdsConversionActionDto>) {
  const primary: string[] = []
  const secondary: string[] = []
  const missing: string[] = []

  for (const actionId of sortedUnique(actionIds)) {
    const action = actionsById.get(actionId)
    if (!action) {
      missing.push(actionId)
      continue
    }
    if (action.primaryForGoal) primary.push(actionId)
    else secondary.push(actionId)
  }

  return {
    conversionActionIds: sortedUnique(actionIds),
    primaryConversionActionIds: primary,
    secondaryConversionActionIds: secondary,
    missingConversionActionIds: missing,
  }
}

function categoryGoalActions(
  goal: Pick<GoogleAdsCustomerConversionGoalDto, 'category' | 'origin'>,
  actions: readonly GoogleAdsConversionActionDto[],
): string[] {
  return actions
    .filter(action => action.category === goal.category && action.origin === goal.origin)
    .map(action => action.id)
}

/**
 * Resolves the campaign-specific goal view without conflating a conversion
 * action's primary flag with the biddability of the campaign goal that contains it.
 * The result is sorted by provider ids so duplicate upstream ordering cannot make
 * an audit's output unstable.
 */
export function deriveGoogleAdsEffectiveGoalGraph(inventory: GoogleAdsInventoryDto): GoogleAdsEffectiveGoalGraphDto {
  const actionsById = new Map(inventory.conversionActions.map(action => [action.id, action]))
  const configurationsByCampaign = new Map(
    [...inventory.campaignGoalConfigurations]
      .sort((left, right) => left.campaignId.localeCompare(right.campaignId))
      .map(configuration => [configuration.campaignId, configuration]),
  )
  const customGoalsById = new Map(inventory.customConversionGoals.map(goal => [goal.id, goal]))
  const customerGoals = [...inventory.customerConversionGoals]
    .sort((left, right) => `${left.category}\u0000${left.origin}`.localeCompare(`${right.category}\u0000${right.origin}`))
  const campaignGoalsByCampaign = new Map<string, GoogleAdsCampaignConversionGoalDto[]>()
  for (const goal of inventory.campaignConversionGoals) {
    const existing = campaignGoalsByCampaign.get(goal.campaignId) ?? []
    existing.push(goal)
    campaignGoalsByCampaign.set(goal.campaignId, existing)
  }
  for (const goals of campaignGoalsByCampaign.values()) {
    goals.sort((left, right) => `${left.category}\u0000${left.origin}`.localeCompare(`${right.category}\u0000${right.origin}`))
  }

  return {
    customerId: inventory.customerId,
    derivedAt: inventory.fetchedAt,
    campaigns: [...inventory.campaigns]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((campaign): GoogleAdsEffectiveCampaignGoalDto => {
        const configuration = configurationsByCampaign.get(campaign.id)
        const goalConfigLevel = configuration?.goalConfigLevel ?? GoogleAdsGoalConfigurationLevels.customer
        const customGoalId = configuration?.customGoalId ?? null

        if (customGoalId) {
          const customGoal = customGoalsById.get(customGoalId)
          if (!customGoal) {
            return {
              campaignId: campaign.id,
              goalConfigLevel,
              customGoalId,
              missingCustomGoalId: customGoalId,
              goals: [],
            }
          }
          return {
            campaignId: campaign.id,
            goalConfigLevel,
            customGoalId,
            missingCustomGoalId: null,
            goals: [{
              source: GoogleAdsEffectiveGoalSources['custom-goal'],
              category: null,
              origin: null,
              customGoalId,
              biddable: null,
              ...actionMembership(customGoal.conversionActionIds, actionsById),
            }],
          }
        }

        const configuredGoals = goalConfigLevel === GoogleAdsGoalConfigurationLevels.campaign
          ? (campaignGoalsByCampaign.get(campaign.id) ?? [])
          : customerGoals
        const source = goalConfigLevel === GoogleAdsGoalConfigurationLevels.campaign
          ? GoogleAdsEffectiveGoalSources['campaign-goal']
          : GoogleAdsEffectiveGoalSources['customer-goal']

        return {
          campaignId: campaign.id,
          goalConfigLevel,
          customGoalId: null,
          missingCustomGoalId: null,
          goals: configuredGoals.map(goal => ({
            source,
            category: goal.category,
            origin: goal.origin,
            customGoalId: null,
            biddable: goal.biddable,
            ...actionMembership(categoryGoalActions(goal, inventory.conversionActions), actionsById),
          })),
        }
      }),
  }
}

export const GOOGLE_ADS_CAMPAIGN_METRICS_MAX_CAMPAIGNS = 50
export const GOOGLE_ADS_CAMPAIGN_METRICS_MAX_DAYS = 31
export const GOOGLE_ADS_CAMPAIGN_METRICS_MAX_ROWS = GOOGLE_ADS_CAMPAIGN_METRICS_MAX_CAMPAIGNS * GOOGLE_ADS_CAMPAIGN_METRICS_MAX_DAYS

/** Explicit account and date bounds keep a read-only provider request operationally bounded. */
export const googleAdsCampaignMetricsQuerySchema = z.object({
  campaignIds: z.array(opaqueIdSchema).min(1).max(GOOGLE_ADS_CAMPAIGN_METRICS_MAX_CAMPAIGNS),
  startDate: calendarDateSchema,
  endDate: calendarDateSchema,
}).strict().superRefine((query, context) => {
  if (new Set(query.campaignIds).size !== query.campaignIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['campaignIds'], message: 'Campaign IDs must be unique.' })
  }
  if (query.endDate < query.startDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'endDate must not precede startDate.' })
    return
  }
  if (inclusiveCalendarDays(query.startDate, query.endDate) > GOOGLE_ADS_CAMPAIGN_METRICS_MAX_DAYS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endDate'],
      message: `Campaign metrics may cover at most ${GOOGLE_ADS_CAMPAIGN_METRICS_MAX_DAYS} calendar days.`,
    })
  }
})
export type GoogleAdsCampaignMetricsQuery = z.infer<typeof googleAdsCampaignMetricsQuerySchema>

export const googleAdsCampaignMetricDtoSchema = z.object({
  campaignId: opaqueIdSchema,
  date: calendarDateSchema,
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative(),
  conversions: z.number().nonnegative(),
  conversionValueMicros: z.number().int().nonnegative().nullable(),
}).strict()
export type GoogleAdsCampaignMetricDto = z.infer<typeof googleAdsCampaignMetricDtoSchema>

export const googleAdsCampaignMetricsResponseSchema = z.object({
  query: googleAdsCampaignMetricsQuerySchema,
  rows: z.array(googleAdsCampaignMetricDtoSchema).max(GOOGLE_ADS_CAMPAIGN_METRICS_MAX_ROWS),
  truncated: z.boolean(),
  fetchedAt: z.string(),
}).strict()
export type GoogleAdsCampaignMetricsResponse = z.infer<typeof googleAdsCampaignMetricsResponseSchema>

export const googleAdsSnapshotKindSchema = z.enum([
  'accessible-customers',
  'inventory',
  'campaign-metrics',
])
export type GoogleAdsSnapshotKind = z.infer<typeof googleAdsSnapshotKindSchema>
export const GoogleAdsSnapshotKinds = googleAdsSnapshotKindSchema.enum

/**
 * Forensic metadata for a provider response. The original body is not stored:
 * only its hash/size and a DTO-shaped, redacted representation may persist.
 */
export const googleAdsRawSnapshotMetadataDtoSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  connectionId: opaqueIdSchema,
  runId: opaqueIdSchema,
  kind: googleAdsSnapshotKindSchema,
  customerId: opaqueIdSchema.nullable(),
  payloadChecksum: sha256Schema,
  rawPayloadSha256: sha256Schema.nullable(),
  rawPayloadBytes: z.number().int().nonnegative().nullable(),
  redactedFieldCount: z.number().int().nonnegative(),
  capturedAt: z.string(),
  createdAt: z.string(),
}).strict()
export type GoogleAdsRawSnapshotMetadataDto = z.infer<typeof googleAdsRawSnapshotMetadataDtoSchema>

export const googleAdsSnapshotPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(GoogleAdsSnapshotKinds['accessible-customers']),
    data: googleAdsAccessibleCustomersResponseSchema,
  }).strict(),
  z.object({
    kind: z.literal(GoogleAdsSnapshotKinds.inventory),
    data: googleAdsInventoryDtoSchema,
  }).strict(),
  z.object({
    kind: z.literal(GoogleAdsSnapshotKinds['campaign-metrics']),
    data: googleAdsCampaignMetricsResponseSchema,
  }).strict(),
])
export type GoogleAdsSnapshotPayload = z.infer<typeof googleAdsSnapshotPayloadSchema>

export const googleAdsRawSnapshotDtoSchema = z.object({
  metadata: googleAdsRawSnapshotMetadataDtoSchema,
  payload: googleAdsSnapshotPayloadSchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.metadata.kind !== snapshot.payload.kind) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload', 'kind'], message: 'Snapshot metadata and payload kinds must match.' })
  }
})
export type GoogleAdsRawSnapshotDto = z.infer<typeof googleAdsRawSnapshotDtoSchema>

/**
 * Windows the stored 31-day metrics snapshot can actually serve.
 *
 * A snapshot holds GOOGLE_ADS_CAMPAIGN_METRICS_MAX_DAYS (31) days, of which at
 * most 30 are closed, so 30d is the widest servable window and it consumes all
 * of them. A period-over-period comparison needs 2N closed days, so 7d and 14d
 * carry one and 30d cannot; that is reported as 'insufficient-history' rather
 * than hidden by removing the option. 90d is not offered at all because the
 * stored snapshot cannot answer it.
 *
 * 30d rather than 28d on purpose: 28 is an artifact of what happened to fit,
 * and operators think in months and weeks, not in multiples of a fortnight.
 */
export const googleAdsMetricsWindowSchema = z.enum(['7d', '14d', '30d'])
export type GoogleAdsMetricsWindow = z.infer<typeof googleAdsMetricsWindowSchema>

/**
 * Every money field is INTEGER MICROS of the account currency. Micros become a
 * formatted currency string only at a render edge (web component, CLI human
 * output) so nothing downstream re-divides or re-rounds.
 *
 * Every ratio is a RAW float and is never rounded server-side; renderers choose
 * display precision. A ratio whose denominator is zero is null, never 0, because
 * an undefined 0/0 is not the same fact as a measured zero.
 */
export const googleAdsMetricTotalsSchema = z.object({
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative(),
  /** FLOAT: Google reports fractional conversions, so 0.5 is a real value. */
  conversions: z.number().nonnegative(),
  /** Null when no row in scope reported a value. */
  conversionValueMicros: z.number().int().nonnegative().nullable(),
  /** clicks / impressions. Null when impressions === 0. */
  ctr: fraction().nullable(),
  /** Math.round(costMicros / clicks). Null when clicks === 0. */
  cpcMicros: z.number().int().nonnegative().nullable(),
  /** conversions / clicks. Null when clicks === 0. */
  conversionRate: fraction().nullable(),
  /** Math.round(costMicros / conversions). Null when conversions === 0. */
  costPerConversionMicros: z.number().int().nonnegative().nullable(),
})
export type GoogleAdsMetricTotals = z.infer<typeof googleAdsMetricTotalsSchema>

/**
 * One calendar day. `origin` distinguishes a day the provider returned from a
 * day densified into the series. On Google Ads a missing day means zero
 * delivery, so a filled day carries measured zeros, not unknowns.
 */
export const googleAdsMetricsDailyPointSchema = z.object({
  date: calendarDateSchema,
  origin: z.enum(['provider', 'filled']),
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative(),
  conversions: z.number().nonnegative(),
  ctr: fraction().nullable(),
})
export type GoogleAdsMetricsDailyPoint = z.infer<typeof googleAdsMetricsDailyPointSchema>

export const googleAdsCampaignPerformanceSchema = z.object({
  campaignId: opaqueIdSchema,
  /** Null when the metrics snapshot names a campaign the inventory snapshot does not. */
  name: z.string().nullable(),
  status: googleAdsCampaignStatusSchema,
  totals: googleAdsMetricTotalsSchema,
})
export type GoogleAdsCampaignPerformance = z.infer<typeof googleAdsCampaignPerformanceSchema>

/**
 * Provenance for the figures, so a reader can tell what produced them.
 *
 * `openDate` is the capture day. Snapshots are taken mid-day, so that day is
 * PARTIAL and is excluded from every window: including it renders a fabricated
 * decline on the right edge of every chart. It is derived from the payload's own
 * fetchedAt, never from a server clock, so a stale snapshot does not silently
 * shift the cutoff.
 */
export const googleAdsPerformanceSourceSchema = z.object({
  snapshotId: opaqueIdSchema,
  capturedAt: z.string(),
  customerId: opaqueIdSchema,
  currencyCode: z.string().nullable(),
  timeZone: z.string().nullable(),
  /** Newest CLOSED day. Every window ends here. */
  asOfDate: calendarDateSchema,
  openDate: calendarDateSchema.nullable(),
  /** True when the provider row cap was hit, so totals are a subset sum. */
  truncated: z.boolean(),
  campaignsQueried: z.number().int().nonnegative(),
  campaignsInInventory: z.number().int().nonnegative(),
})
export type GoogleAdsPerformanceSource = z.infer<typeof googleAdsPerformanceSourceSchema>

const googleAdsPerformancePeriodSchema = z.object({
  startDate: calendarDateSchema,
  endDate: calendarDateSchema,
  days: z.number().int().positive(),
  totals: googleAdsMetricTotalsSchema,
})

/**
 * Prior-equal-period comparison. Null (not zero) when the stored window cannot
 * cover 2N closed days, with `unavailableReason` saying which constraint bit.
 */
export const googleAdsPerformanceComparisonSchema = z.object({
  days: z.number().int().positive(),
  prior: googleAdsPerformancePeriodSchema,
  change: z.object({
    impressions: fraction().nullable(),
    clicks: fraction().nullable(),
    costMicros: fraction().nullable(),
    conversions: fraction().nullable(),
    ctr: fraction().nullable(),
    conversionRate: fraction().nullable(),
  }),
})
export type GoogleAdsPerformanceComparison = z.infer<typeof googleAdsPerformanceComparisonSchema>

export const googleAdsPerformanceDtoSchema = z.object({
  window: googleAdsMetricsWindowSchema,
  startDate: calendarDateSchema,
  endDate: calendarDateSchema,
  days: z.number().int().positive(),
  totals: googleAdsMetricTotalsSchema,
  daily: z.array(googleAdsMetricsDailyPointSchema),
  campaigns: z.array(googleAdsCampaignPerformanceSchema),
  comparison: googleAdsPerformanceComparisonSchema.nullable(),
  comparisonUnavailableReason: z.enum(['insufficient-history', 'no-snapshot']).nullable(),
  source: googleAdsPerformanceSourceSchema.nullable(),
})
export type GoogleAdsPerformanceDto = z.infer<typeof googleAdsPerformanceDtoSchema>
