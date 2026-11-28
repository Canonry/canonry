import { describeError, type GaOverviewWindow } from '@canonry/canonry-contracts'

/** An overview window whose GA4 report failed this sync. */
export interface GaWindowFailure {
  window: GaOverviewWindow
  error: unknown
}

/**
 * Splits one settled report per overview window into the reports GA4 answered
 * (in request order) and the windows it did not.
 *
 * The long windows are the slow reports: GA4 counts distinct users over each
 * whole range, and a 90- or 180-day report can outlast its timeout while every
 * daily report answers in seconds. A window that fails keeps the totals an
 * earlier sync stored, so one slow window no longer costs the sync its daily
 * data.
 */
export function settleGaWindows<T>(
  windows: readonly GaOverviewWindow[],
  results: readonly PromiseSettledResult<T>[],
): { read: T[]; failed: GaWindowFailure[] } {
  const read: T[] = []
  const failed: GaWindowFailure[] = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') read.push(result.value)
    else failed.push({ window: windows[index]!, error: result.reason })
  })
  return { read, failed }
}

/**
 * The windows a sync kept from an earlier sync, once each, in window order,
 * with the first error GA4 gave for it.
 */
export function keptGaWindows(
  windows: readonly GaOverviewWindow[],
  failures: readonly GaWindowFailure[],
): Array<{ window: GaOverviewWindow; error: string }> {
  return windows.flatMap((window) => {
    const failure = failures.find((entry) => entry.window === window)
    return failure ? [{ window, error: describeError(failure.error) }] : []
  })
}
