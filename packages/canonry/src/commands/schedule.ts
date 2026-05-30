import type { ScheduleDto } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'

function getClient() {
  return createApiClient()
}

export async function setSchedule(project: string, opts: {
  kind?: string
  sourceId?: string
  preset?: string
  cron?: string
  timezone?: string
  providers?: string[]
  format?: string
}): Promise<void> {
  const client = getClient()
  const body: Record<string, unknown> = {}
  if (opts.kind) body.kind = opts.kind
  if (opts.sourceId) body.sourceId = opts.sourceId
  if (opts.preset) body.preset = opts.preset
  if (opts.cron) body.cron = opts.cron
  if (opts.timezone) body.timezone = opts.timezone
  if (opts.providers?.length) body.providers = opts.providers

  const result: ScheduleDto = await client.putSchedule(project, body)
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Schedule set for "${project}" (kind: ${result.kind}):`)
  printSchedule(result)
}

export async function showSchedule(project: string, format?: string, kind?: string): Promise<void> {
  const client = getClient()
  const result: ScheduleDto = await client.getSchedule(project, kind)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  printSchedule(result)
}

export async function enableSchedule(project: string, format?: string, kind?: string): Promise<void> {
  const client = getClient()
  const current: ScheduleDto = await client.getSchedule(project, kind)
  const body: Record<string, unknown> = { kind: current.kind, timezone: current.timezone, enabled: true }
  if (current.preset) body.preset = current.preset
  else body.cron = current.cronExpr
  if (current.providers.length) body.providers = current.providers
  if (current.sourceId) body.sourceId = current.sourceId

  const result: ScheduleDto = await client.putSchedule(project, body)
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Schedule enabled for "${project}" (kind: ${result.kind})`)
}

export async function disableSchedule(project: string, format?: string, kind?: string): Promise<void> {
  const client = getClient()
  const current: ScheduleDto = await client.getSchedule(project, kind)
  const body: Record<string, unknown> = { kind: current.kind, timezone: current.timezone, enabled: false }
  if (current.preset) body.preset = current.preset
  else body.cron = current.cronExpr
  if (current.providers.length) body.providers = current.providers
  if (current.sourceId) body.sourceId = current.sourceId

  const result: ScheduleDto = await client.putSchedule(project, body)
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Schedule disabled for "${project}" (kind: ${result.kind})`)
}

export async function removeSchedule(project: string, format?: string, kind?: string): Promise<void> {
  const client = getClient()
  await client.deleteSchedule(project, kind)
  const resolvedKind = kind ?? 'answer-visibility'
  if (isMachineFormat(format)) {
    console.log(JSON.stringify({ project, kind: resolvedKind, removed: true }, null, 2))
    return
  }
  console.log(`Schedule removed for "${project}" (kind: ${resolvedKind})`)
}

export function printSchedule(s: ScheduleDto): void {
  console.log(`  Kind:      ${s.kind}`)
  // Only show the friendly preset name when set — without this guard, schedules
  // configured via `--cron` print the cron expression twice (once on this line,
  // once on the next).
  if (s.preset) {
    console.log(`  Preset:    ${s.preset}`)
  }
  console.log(`  Cron:      ${s.cronExpr}`)
  console.log(`  Timezone:  ${s.timezone}`)
  console.log(`  Enabled:   ${s.enabled ? 'yes' : 'no'}`)
  if (s.kind === 'traffic-sync' && s.sourceId) {
    console.log(`  Source:    ${s.sourceId}`)
  }
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
