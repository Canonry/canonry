import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameScheduleOptions } from '@ainyc/canonry-api-client/react-query'
import { RunKinds } from '@ainyc/canonry-contracts'
import { heyClient } from '../../api.js'

export const MANAGED_SWEEPS_COPY = 'Sweeps are run by your Canonry team'

export function ManagedSweepStatus({ projectName }: { projectName: string }) {
  const scheduleQuery = useQuery({
    ...getApiV1ProjectsByNameScheduleOptions({
      client: heyClient,
      path: { name: projectName },
      query: { kind: RunKinds['answer-visibility'] },
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
      {nextSync && nextRun ? <>
        Next sync <time dateTime={nextRun.toISOString()}>{nextSync} UTC</time> · managed by your Canonry team
      </> : MANAGED_SWEEPS_COPY}
    </p>
  )
}
