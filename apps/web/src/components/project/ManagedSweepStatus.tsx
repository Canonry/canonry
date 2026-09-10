import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameScheduleOptions } from '@ainyc/canonry-api-client/react-query'
import { RunKinds, type SchedulableRunKind } from '@ainyc/canonry-contracts'
import { ApiError, heyClient } from '../../api.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'

export const MANAGED_SWEEPS_COPY = 'Sweeps are run by your Canonry team'

export const MANAGED_SCANS_COPY = 'Scans are run by your Canonry team'
export const MANAGED_SWEEPS_UNAVAILABLE_COPY = 'Next sweep unavailable'
export const MANAGED_SWEEPS_RUNNING_COPY = 'Sweep running…'
export const MANAGED_SWEEPS_NEXT_LABEL = 'Next sweep:'

function managedSweepDate(iso: string, timezone: string | undefined): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: timezone ?? 'UTC',
    }).format(new Date(iso))
  } catch {
    return null
  }
}

function ordinalDay(day: number): string {
  const remainder = day % 100
  if (remainder >= 11 && remainder <= 13) return `${day}th`
  switch (day % 10) {
    case 1: return `${day}st`
    case 2: return `${day}nd`
    case 3: return `${day}rd`
    default: return `${day}th`
  }
}

function portfolioSweepDate(iso: string, timezone: string | undefined): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      month: 'long', day: 'numeric', year: 'numeric', timeZone: timezone ?? 'UTC',
    }).formatToParts(new Date(iso))
    const month = parts.find(part => part.type === 'month')?.value
    const day = Number(parts.find(part => part.type === 'day')?.value)
    const year = parts.find(part => part.type === 'year')?.value
    return month && Number.isInteger(day) && year ? `${month} ${ordinalDay(day)}, ${year}` : null
  } catch {
    return null
  }
}

export function ManagedSweepStatus({ projectName, kind = RunKinds['answer-visibility'], running = false, portfolio = false }: {
  projectName: string
  kind?: SchedulableRunKind
  running?: boolean
  /** Advanced Measurement portfolios show client-facing schedule language. */
  portfolio?: boolean
}) {
  const scan = kind === RunKinds['site-audit']
  const scheduleQuery = useQuery({
    ...getApiV1ProjectsByNameScheduleOptions({
      client: heyClient,
      path: { name: projectName },
      query: { kind },
    }),
    retry: false,
    refetchInterval: 60_000,
  })
  const schedule = scheduleQuery.isError ? undefined : scheduleQuery.data
  const nextRun = schedule?.enabled && schedule.nextRunAt ? new Date(schedule.nextRunAt) : null
  const nextSync = nextRun && Number.isFinite(nextRun.getTime())
    ? scan ? nextRun.toLocaleString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        timeZone: 'UTC', hourCycle: 'h23',
      }) : managedSweepDate(nextRun.toISOString(), schedule?.timezone)
    : null

  const errorCode = scheduleQuery.error instanceof ApiError ? scheduleQuery.error.code
    : (scheduleQuery.error as { error?: { code?: string } } | null)?.error?.code
  const missingSchedule = errorCode === 'NOT_FOUND'
  const unavailableSweep = !nextSync || missingSchedule || !schedule?.enabled
  const portfolioNextSync = nextRun && Number.isFinite(nextRun.getTime())
    ? portfolioSweepDate(nextRun.toISOString(), schedule?.timezone)
    : null

  return (
    <p className="text-sm text-secondary" role="status">
      {scan ? <>
        {running && <span className="text-neutral">Scan running… · </span>}
        {nextSync && nextRun ? <>
          Next scan <time dateTime={nextRun.toISOString()}>{nextSync} UTC</time> · managed by your Canonry team
        </> : MANAGED_SCANS_COPY}
      </> : running ? MANAGED_SWEEPS_RUNNING_COPY : unavailableSweep ? MANAGED_SWEEPS_UNAVAILABLE_COPY : nextSync && nextRun ? portfolio && portfolioNextSync ? <>
        Next Portfolio AI visibility Sweep: <time dateTime={nextRun.toISOString()}>{portfolioNextSync}</time> <InfoTooltip text="This is managed by your Canonry team." />
      </> : <>
        {MANAGED_SWEEPS_NEXT_LABEL} <time dateTime={nextRun.toISOString()}>{nextSync}</time>
      </> : MANAGED_SWEEPS_UNAVAILABLE_COPY}
    </p>
  )
}
