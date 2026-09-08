import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameScheduleOptions } from '@ainyc/canonry-api-client/react-query'
import { RunKinds, type SchedulableRunKind } from '@ainyc/canonry-contracts'
import { heyClient } from '../../api.js'

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
    ? nextRun.toLocaleString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        timeZone: 'UTC', hourCycle: 'h23',
      })
    : null

  return (
    <p className="text-sm text-secondary" role="status">
      {running && <span className="text-neutral">{scan ? 'Scan running…' : 'AI sweep running…'} · </span>}
      {nextSync && nextRun ? <>
        Next {scan ? 'scan' : 'sync'} <time dateTime={nextRun.toISOString()}>{nextSync} UTC</time> · managed by your Canonry team
      </> : scan ? MANAGED_SCANS_COPY : MANAGED_SWEEPS_COPY}
    </p>
  )
}
