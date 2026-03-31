import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient()
}

interface ScheduleResponse {
  id: string
  projectId: string
  cronExpr: string
  preset: string | null
  timezone: string
  enabled: boolean
  providers: string[]
  lastRunAt: string | null
  nextRunAt: string | null
}

export async function setSchedule(project: string, opts: {
  preset?: string
  cron?: string
  timezone?: string
  providers?: string[]
  format?: string
}): Promise<void> {
  const client = getClient()
  const body: Record<string, unknown> = {}
  if (opts.preset) body.preset = opts.preset
  if (opts.cron) body.cron = opts.cron
  if (opts.timezone) body.timezone = opts.timezone
  if (opts.providers?.length) body.providers = opts.providers

  const result = await client.putSchedule(project, body) as ScheduleResponse
  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Schedule set for "${project}":`)
  printSchedule(result)
}

export async function showSchedule(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.getSchedule(project) as ScheduleResponse

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  printSchedule(result)
}

export async function enableSchedule(project: string, format?: string): Promise<void> {
  const client = getClient()
  const current = await client.getSchedule(project) as ScheduleResponse
  const body: Record<string, unknown> = { timezone: current.timezone, enabled: true }
  if (current.preset) body.preset = current.preset
  else body.cron = current.cronExpr
  if (current.providers.length) body.providers = current.providers

  const result = await client.putSchedule(project, body) as ScheduleResponse
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Schedule enabled for "${project}"`)
}

export async function disableSchedule(project: string, format?: string): Promise<void> {
  const client = getClient()
  const current = await client.getSchedule(project) as ScheduleResponse
  const body: Record<string, unknown> = { timezone: current.timezone, enabled: false }
  if (current.preset) body.preset = current.preset
  else body.cron = current.cronExpr
  if (current.providers.length) body.providers = current.providers

  const result = await client.putSchedule(project, body) as ScheduleResponse
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Schedule disabled for "${project}"`)
}

export async function removeSchedule(project: string, format?: string): Promise<void> {
  const client = getClient()
  await client.deleteSchedule(project)
  if (format === 'json') {
    console.log(JSON.stringify({ project, removed: true }, null, 2))
    return
  }
  console.log(`Schedule removed for "${project}"`)
}

function printSchedule(s: ScheduleResponse): void {
  const label = s.preset ?? s.cronExpr
  console.log(`  Schedule:  ${label}`)
  console.log(`  Cron:      ${s.cronExpr}`)
  console.log(`  Timezone:  ${s.timezone}`)
  console.log(`  Enabled:   ${s.enabled ? 'yes' : 'no'}`)
  if (s.providers.length) {
    console.log(`  Providers: ${s.providers.join(', ')}`)
  }
  if (s.lastRunAt) {
    console.log(`  Last run:  ${s.lastRunAt}`)
  }
  if (s.nextRunAt) {
    console.log(`  Next run:  ${s.nextRunAt}`)
  }
}
