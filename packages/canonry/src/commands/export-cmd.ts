import { stringify } from 'yaml'
import { createApiClient, type ApiClient, type ExportDto } from '../client.js'
import { isEndpointMissing, isMachineFormat } from '../cli-error.js'
import { isRedactedNotificationUrl } from '@ainyc/canonry-contracts'

export async function exportProject(
  project: string,
  opts: { includeResults?: boolean; includeSecrets?: boolean; format?: string },
): Promise<void> {
  const client = createApiClient()

  const data: ExportDto = opts.includeSecrets
    ? await client.getExport(project, { includeSecrets: true })
    : await client.getExport(project)

  if (data.spec.notifications?.some(notification => isRedactedNotificationUrl(notification.url))) {
    console.error('Notification webhook URLs are redacted. Use --include-secrets with administrator authority to export them.')
  }

  if (opts.includeResults) {
    const results = await loadLatestRunForExport(client, project)
    if (results) data.results = results
  }

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  console.log(stringify(data))
}

async function loadLatestRunForExport(client: ApiClient, project: string): Promise<unknown | null> {
  try {
    const latest = await client.getLatestRun(project)
    return latest.run ?? null
  } catch (err) {
    if (!isEndpointMissing(err)) throw err
  }
  // Older server predating /runs/latest — fall back to list + detail fetch.
  const runs = await client.listRuns(project)
  if (runs.length === 0) return null
  const latestRun = runs.reduce((current, candidate) =>
    candidate.createdAt > current.createdAt ? candidate : current,
  )
  return client.getRun(latestRun.id)
}
