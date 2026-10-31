/**
 * Pure comparison engine behind `GET /projects/:name/ads/live-delivery`.
 *
 * No DB, no clock, no network (the `gbp-summary.ts` / `visibility-compare.ts`
 * precedent): the route does the bounded provider walk and the stored reads,
 * then hands both sides here to be diffed. Everything in this file is
 * deterministic and unit-testable without a provider.
 */
import {
  dollarsToMicros,
  formatIsoDateInTimeZone,
  isoDateDaysBeforeInTimeZone,
} from '@canonry/canonry-contracts'
import type {
  AdsLiveDeliveryDto,
  AdsLiveEntityComparison,
  AdsLiveEntityState,
  AdsLiveEntityType,
  AdsLiveFieldDelta,
  AdsLiveMetricDelta,
  AdsLiveMetricRow,
  AdsLiveMetricValues,
  AdsLivePresence,
  AdsStoredEntityState,
} from '@canonry/canonry-contracts'
import { AdsLivePresences } from '@canonry/canonry-contracts'

/** A stored `ads_insights_daily` row, already narrowed to the comparable columns. */
export interface AdsStoredMetricRow {
  date: string
  impressions: number
  clicks: number
  spendMicros: number
  conversions: number
}

export interface AdsLiveEntityObservation {
  entityType: AdsLiveEntityType
  id: string
  parentId: string | null
  live: AdsLiveEntityState | null
  stored: AdsStoredEntityState | null
  /** Provider metric rows verbatim. Null when the level has no insights surface. */
  liveMetrics: AdsLiveMetricRow[] | null
  storedMetrics: AdsStoredMetricRow[] | null
}

export interface AdsLiveComparisonWindow {
  /** Inclusive `YYYY-MM-DD`. Stored dates outside the window are not compared. */
  startDate: string
  /** Inclusive `YYYY-MM-DD`. */
  endDate: string
}

/**
 * The date window the stored side is compared over, dated in the ACCOUNT's
 * timezone.
 *
 * Every date in this comparison is an account-local calendar date. The
 * provider's insight range is requested in the account timezone, the provider
 * stamps each bucket with its own local `readable_time`, and ads-sync stores
 * that value verbatim as the rollup date. Deriving these boundaries in UTC
 * instead misreports drift twice over for any account whose local date differs
 * from the UTC date at the read instant:
 *
 * - East of UTC, the account's current local day is already tomorrow in local
 *   terms but still today in UTC, so the stored row for that day falls past a
 *   UTC `endDate` and is filtered out while the provider's row for the same
 *   day is kept. The response then claims there is no stored row at all.
 * - At the other end, a UTC `startDate` a day early admits a stored day the
 *   provider was never asked about, which reads as the provider having dropped
 *   real data.
 *
 * `startDate` is also the date the PROVIDER range is asked to start at, from
 * the start of that account-local day (see `AdsLiveInsightsRequest`). The two
 * boundaries have one derivation on purpose. When the provider's range instead
 * began at the read instant's local hour, the first day of every window was a
 * mid-day slice upstream and a whole day in the rollup, so the diff
 * manufactured drift on it on every read no matter how healthy the account was.
 *
 * `endDate` is the account's CURRENT local day, which is in progress on both
 * sides: the live side runs to the read instant and the stored side to the last
 * ads-sync. A difference there is snapshot staleness, which is the signal this
 * endpoint exists to surface, so it is reported as the drift it is.
 *
 * `lookbackDays` counts CALENDAR days in that same zone, which is why the start
 * is stepped by `isoDateDaysBeforeInTimeZone` rather than by subtracting
 * `lookbackDays × 24h` from the read instant. A local day is not always 24
 * hours: the day a zone springs forward is 23 and the day it falls back is 25,
 * so a fixed-duration step lands on the wrong calendar date around a transition
 * and the window then gains or loses a metric date.
 */
export function liveComparisonWindow(
  fetchedAtMs: number,
  lookbackDays: number,
  timezone: string,
): AdsLiveComparisonWindow {
  const fetchedAtIso = new Date(fetchedAtMs).toISOString()
  return {
    startDate: isoDateDaysBeforeInTimeZone(fetchedAtIso, lookbackDays, timezone),
    endDate: formatIsoDateInTimeZone(fetchedAtIso, timezone),
  }
}

const EMPTY_METRIC_VALUES: AdsLiveMetricValues = {
  impressions: 0,
  clicks: 0,
  spendMicros: 0,
  conversions: 0,
}

function presenceOf(
  live: AdsLiveEntityState | null,
  stored: AdsStoredEntityState | null,
): AdsLivePresence {
  if (live && stored) return AdsLivePresences.both
  if (live) return AdsLivePresences['live-only']
  return AdsLivePresences['stored-only']
}

function fieldDelta(
  field: string,
  live: string | null,
  stored: string | null,
): AdsLiveFieldDelta | null {
  return live === stored ? null : { field, live, stored }
}

/**
 * Status / name / review drift for an entity present on both sides. An entity
 * present on only one side has no field delta: its `presence` already says
 * everything, and pairing a value against "absent" would read as a value change.
 */
export function buildFieldDeltas(
  live: AdsLiveEntityState | null,
  stored: AdsStoredEntityState | null,
): AdsLiveFieldDelta[] {
  if (!live || !stored) return []
  const deltas = [
    fieldDelta('status', live.status, stored.status),
    fieldDelta('reviewStatus', live.reviewStatus, stored.reviewStatus),
    fieldDelta('name', live.name, stored.name),
  ]
  return deltas.filter((delta): delta is AdsLiveFieldDelta => delta !== null)
}

/**
 * Fold the provider's rows for one date into comparable totals.
 *
 * The provider returns one row per time bucket, and buckets are disjoint, so
 * impressions / clicks / spend / conversions are additive within a date. The
 * ratio metrics (ctr / cpc / cpm) are NOT additive and are deliberately absent
 * here. They survive only in `liveMetrics`, exactly as the provider sent them.
 * Spend is converted from the insights API's decimal currency units to the
 * integer micros the local rollups store, so the two sides are commensurable.
 */
function foldLiveRows(rows: readonly AdsLiveMetricRow[]): AdsLiveMetricValues {
  let values = EMPTY_METRIC_VALUES
  for (const row of rows) {
    values = {
      impressions: values.impressions + Math.round(row.impressions ?? 0),
      clicks: values.clicks + Math.round(row.clicks ?? 0),
      spendMicros: values.spendMicros + dollarsToMicros(row.spend ?? 0),
      conversions: values.conversions + Math.round(row.conversions ?? 0),
    }
  }
  return values
}

function sameMetrics(a: AdsLiveMetricValues, b: AdsLiveMetricValues): boolean {
  return a.impressions === b.impressions
    && a.clicks === b.clicks
    && a.spendMicros === b.spendMicros
    && a.conversions === b.conversions
}

/**
 * Per-date live-vs-stored metric comparison over the requested window.
 *
 * Dates are the union of the dates the provider reported and the stored dates
 * that fall inside the window. Stored history older than the window is not
 * compared: the provider was never asked about it, so its absence upstream is
 * not drift.
 */
export function buildMetricDeltas(
  liveRows: readonly AdsLiveMetricRow[] | null,
  storedRows: readonly AdsStoredMetricRow[] | null,
  window: AdsLiveComparisonWindow,
): AdsLiveMetricDelta[] | null {
  if (liveRows === null && storedRows === null) return null

  const liveByDate = new Map<string, AdsLiveMetricRow[]>()
  for (const row of liveRows ?? []) {
    if (row.date === null) continue
    const bucket = liveByDate.get(row.date) ?? []
    bucket.push(row)
    liveByDate.set(row.date, bucket)
  }

  const storedByDate = new Map<string, AdsStoredMetricRow>()
  for (const row of storedRows ?? []) {
    if (row.date < window.startDate || row.date > window.endDate) continue
    storedByDate.set(row.date, row)
  }

  const dates = [...new Set([...liveByDate.keys(), ...storedByDate.keys()])].sort()
  return dates.map((date) => {
    const liveBucket = liveByDate.get(date)
    const storedRow = storedByDate.get(date)
    const live = liveBucket ? foldLiveRows(liveBucket) : null
    const stored = storedRow
      ? {
          impressions: storedRow.impressions,
          clicks: storedRow.clicks,
          spendMicros: storedRow.spendMicros,
          conversions: storedRow.conversions,
        }
      : null
    const drifted = live === null || stored === null || !sameMetrics(live, stored)
    return { date, live, stored, drifted }
  })
}

export function buildLiveEntityComparison(
  observation: AdsLiveEntityObservation,
  window: AdsLiveComparisonWindow,
): AdsLiveEntityComparison {
  const presence = presenceOf(observation.live, observation.stored)
  const fieldDeltas = buildFieldDeltas(observation.live, observation.stored)
  const metricDeltas = buildMetricDeltas(observation.liveMetrics, observation.storedMetrics, window)
  const drifted = presence !== AdsLivePresences.both
    || fieldDeltas.length > 0
    || (metricDeltas?.some((delta) => delta.drifted) ?? false)
  return {
    entityType: observation.entityType,
    id: observation.id,
    parentId: observation.parentId,
    presence,
    live: observation.live,
    stored: observation.stored,
    fieldDeltas,
    liveMetrics: observation.liveMetrics,
    metricDeltas,
    drifted,
  }
}

export function summarizeLiveDrift(
  entities: readonly AdsLiveEntityComparison[],
): AdsLiveDeliveryDto['drift'] {
  let driftedEntities = 0
  let statusDrifted = 0
  let metricsDrifted = 0
  for (const entity of entities) {
    if (entity.drifted) driftedEntities += 1
    if (entity.fieldDeltas.some((delta) => delta.field === 'status')) statusDrifted += 1
    if (entity.metricDeltas?.some((delta) => delta.drifted)) metricsDrifted += 1
  }
  return {
    entitiesCompared: entities.length,
    driftedEntities,
    statusDrifted,
    metricsDrifted,
  }
}
