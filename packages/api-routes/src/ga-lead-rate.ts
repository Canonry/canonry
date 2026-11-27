import {
  AiEngineLeadRateUnavailableReasons,
  countedLeadEventNames,
  countsKeyEvents,
} from '@canonry/canonry-contracts'
import type {
  AiEngineLeadRateUnavailableReason,
  GaMeasurementComponentStatus,
  MeasurementConfig,
} from '@canonry/canonry-contracts'

/**
 * Shared rules for dividing GA4 lead events (`ga_lead_events_daily`) by
 * sessions (`ga_acquisition_daily`). The two tables come from separate sync
 * components, so every surface that puts one over the other reads the same
 * counted events and withholds the rate for the same reasons.
 */

/**
 * The events a project counts and which of them a lead sync has fetched.
 *
 * Counted: the configured lead events, plus the property's key events when
 * that is on. Measured: the last successfully synced set (or, before one was
 * recorded, the configured events). Only counted AND measured events are
 * read, so an event that left the set, or one not fetched yet, never reads as
 * a zero.
 */
export function resolveLeadEvents(
  measurement: Pick<MeasurementConfig, 'leadEventNames' | 'countKeyEvents'>,
  state: { keyEventNames: string[] | null; leadEventNames: string[] | null } | undefined,
) {
  const configuredLeadEvents = [...measurement.leadEventNames]
  const keyEventNames = countsKeyEvents(measurement) ? (state?.keyEventNames ?? null) : null
  const countedEventNames = countedLeadEventNames(configuredLeadEvents, keyEventNames ?? [])
  const measuredEventSet = new Set(state?.leadEventNames ?? configuredLeadEvents)
  const reportedEventNames = countedEventNames.filter(name => measuredEventSet.has(name))
  return { configuredLeadEvents, keyEventNames, countedEventNames, measuredEventSet, reportedEventNames }
}

export function latestDate(rows: Iterable<{ date: string }>): string | null {
  let latest: string | null = null
  for (const row of rows) {
    if (latest === null || row.date > latest) latest = row.date
  }
  return latest
}

/** True when some day with a stored lead row has no stored acquisition row at all. */
export function hasLeadDayWithoutSessions(
  acquisitionRows: Iterable<{ date: string }>,
  leadRows: Iterable<{ date: string }>,
): boolean {
  const acquisitionDates = new Set<string>()
  for (const row of acquisitionRows) acquisitionDates.add(row.date)
  for (const row of leadRows) {
    if (!acquisitionDates.has(row.date)) return true
  }
  return false
}

/**
 * Why a lead rate would divide unlike data, or null when it is honest. The
 * coverage checks read the unfiltered rows of the window: acquisition and
 * leads are separate sync components, and when acquisition stops landing (or
 * skips days) while leads keep landing, a bucket holds leads for days with no
 * stored sessions.
 */
export function leadRateUnavailableReason(input: {
  hasData: boolean
  acquisitionStatus: GaMeasurementComponentStatus | undefined
  leadStatus: GaMeasurementComponentStatus | undefined
  channelLeadsUnfiltered: boolean
  paidOnlyByLandingPage: boolean
  latestAcquisitionDate: string | null
  latestLeadDate: string | null
  leadDayWithoutSessions: boolean
  /** True when the window holds sessions from days before the first stored lead event. */
  sessionsBeforeLeads?: boolean
}): AiEngineLeadRateUnavailableReason | null {
  if (!input.hasData) return AiEngineLeadRateUnavailableReasons['no-data']
  if (input.acquisitionStatus !== 'ready' || input.leadStatus !== 'ready') {
    return AiEngineLeadRateUnavailableReasons['sync-not-ready']
  }
  if (input.channelLeadsUnfiltered) return AiEngineLeadRateUnavailableReasons['channel-leads-unfiltered']
  if (input.paidOnlyByLandingPage) return AiEngineLeadRateUnavailableReasons['paid-split-needs-landing-page']
  if (
    input.latestLeadDate !== null
    && (input.latestAcquisitionDate === null || input.latestAcquisitionDate < input.latestLeadDate)
  ) {
    return AiEngineLeadRateUnavailableReasons['sessions-behind-leads']
  }
  if (input.leadDayWithoutSessions) return AiEngineLeadRateUnavailableReasons['sessions-missing-on-lead-days']
  if (input.sessionsBeforeLeads) return AiEngineLeadRateUnavailableReasons['sessions-before-leads']
  return null
}
