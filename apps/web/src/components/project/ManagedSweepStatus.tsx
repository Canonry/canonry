import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameScheduleOptions } from '@ainyc/canonry-api-client/react-query'
import { formatZonedTimestamp, RunKinds, type SchedulableRunKind } from '@ainyc/canonry-contracts'
import { ApiError, heyClient } from '../../api.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'

export const MANAGED_SWEEPS_COPY = 'Sweeps are run by your Canonry team'

export const MANAGED_SCANS_COPY = 'Scans are run by your Canonry team'

export function ManagedSweepStatus({ projectName, kind = RunKinds['answer-visibility'], running = false }: {
  projectName: string
  kind?: SchedulableRunKind
  running?: boolean
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
      }) : formatZonedTimestamp(nextRun.toISOString(), schedule?.timezone)
    : null

  const errorCode = scheduleQuery.error instanceof ApiError ? scheduleQuery.error.code
    : (scheduleQuery.error as { error?: { code?: string } } | null)?.error?.code
  const missingSchedule = errorCode === 'NOT_FOUND'
  const scheduleHelp = scheduleQuery.isPending ? 'Checking the next scheduled time.'
    : scheduleQuery.isError && !missingSchedule ? 'The next scheduled time could not be loaded.'
    : !schedule ? 'No automatic sweep is currently scheduled.'
    : !schedule.enabled ? 'Automatic sweeps are paused.'
    : nextSync ? `The next AI Visibility sweep is scheduled to start ${nextSync}. Results update after the sweep finishes.`
    : 'The next scheduled time has not been set.'

  return (
    <div className="inline-flex items-center gap-1">
    <p className="text-sm text-secondary" role="status">
      {running && <span className="text-neutral">{scan ? 'Scan running…' : 'AI sweep running…'} · </span>}
      {nextSync && nextRun ? <>
        Next {scan ? 'scan' : 'scheduled sweep'} <time dateTime={nextRun.toISOString()}>{nextSync}{scan ? ' UTC' : ''}</time> · managed by your Canonry team
      </> : scan ? MANAGED_SCANS_COPY : MANAGED_SWEEPS_COPY}
    </p>
    {!scan && <InfoTooltip text={`${MANAGED_SWEEPS_COPY}. ${scheduleHelp}`} />}
    </div>
  )
}
