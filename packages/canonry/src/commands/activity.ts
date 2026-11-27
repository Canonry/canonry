import { formatRunErrorOneLine, type RunsAttentionDto } from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'

export interface ShowActivityOpts {
  format?: string
  since?: string
}

/**
 * Overview's Activity as text lines: each job that needs attention with its
 * project, kind, location, status, time and run id, and the error of a failed
 * or partial run. `canonry activity` and `canonry overview --all` print these.
 */
export function activityLines(activity: RunsAttentionDto): string[] {
  if (activity.items.length === 0) return [`No failed or running jobs since ${activity.since.slice(0, 10)}.`]
  return activity.items.flatMap(({ project, run }) => {
    const where = run.location ? ` · ${run.location}` : ''
    const line = `${project.displayName || project.name} · ${run.kind}${where} · ${run.status} · ${run.createdAt} · ${run.id}`
    return run.error ? [line, `  error: ${formatRunErrorOneLine(run.error)}`] : [line]
  })
}

/**
 * `canonry activity`: the jobs that need attention across every project the
 * key can see (`GET /runs/attention`), the list the dashboard's Activity shows.
 * JSON is the API response unchanged.
 */
export async function showActivity(opts: ShowActivityOpts): Promise<void> {
  const activity = await createApiClient().getRunsAttention({ since: opts.since })
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(activity, null, 2))
    return
  }
  console.log('\nActivity (jobs that failed or are still running):\n')
  for (const line of activityLines(activity)) console.log(`  ${line}`)
  console.log()
}
