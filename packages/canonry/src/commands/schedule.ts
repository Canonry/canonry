import type { ScheduleDto } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

export async function listSchedules(project: string, format?: string): Promise<void> {
  const schedules = await getClient().listSchedules(project)
  if (format === 'jsonl') { emitJsonl(schedules); return }
  if (format === 'json') { console.log(JSON.stringify(schedules, null, 2)); return }
  if (!schedules.length) console.log(`No schedules configured for "${project}"`)
  for (const schedule of schedules) printSchedule(schedule)
}

function getClient() {
  return createApiClient()
}

/**
 * Current schedule for `kind`, or undefined when none exists yet. A create must
 * not fail just because there is nothing to read.
 */
async function readCurrentSchedule(
  client: ReturnType<typeof getClient>,
  project: string,
  kind?: string,
): Promise<ScheduleDto | undefined> {
  try {
    return await client.getSchedule(project, kind)
  } catch {
    // No schedule yet: this is a create, not a failure. Any other read error
    // also lands here, which is why the caller must still send an explicit
    // timezone/providers when it has them: a swallowed read must never
    // silently reintroduce the flag-only body this function exists to avoid.
    return undefined
  }
}

export async function setSchedule(project: string, opts: {
  kind?: string
  sourceId?: string
  preset?: string
  cron?: string
  everyDays?: string
  startDate?: string
  at?: string
  timezone?: string
  providers?: string[]
  format?: string
}): Promise<void> {
  const client = getClient()
  // PUT /schedule REPLACES the row: the request schema defaults `timezone` to
  // 'UTC' and `providers` to [] when they are absent. So a flag-only body
  // silently relocates the schedule and drops its pinned providers, which then
  // falls back to the project's provider list on the next run. Read the current
  // schedule and carry forward everything the caller did not explicitly set,
  // exactly as enableSchedule/disableSchedule already do.
  const current = await readCurrentSchedule(client, project, opts.kind)
  const body: Record<string, unknown> = {}
  if (opts.kind) body.kind = opts.kind
  else if (current) body.kind = current.kind

  // Timing is exclusive: an explicitly supplied one replaces whatever is set.
  if (opts.everyDays || opts.startDate || opts.at) {
    body.recurrence = { everyDays: Number(opts.everyDays), startDate: opts.startDate, time: opts.at }
  } else if (opts.preset) body.preset = opts.preset
  else if (opts.cron) body.cron = opts.cron
  else if (current?.recurrence) body.recurrence = current.recurrence
  else if (current?.preset) body.preset = current.preset
  else if (current?.cronExpr) body.cron = current.cronExpr

  if (opts.timezone) body.timezone = opts.timezone
  else if (current) body.timezone = current.timezone

  if (opts.providers?.length) body.providers = opts.providers
  else if (current?.providers.length) body.providers = current.providers

  if (opts.sourceId) body.sourceId = opts.sourceId
  else if (current?.sourceId) body.sourceId = current.sourceId

  // Only guard when there is a row to guard; a create must stay a create.
  if (current) body.expectedUpdatedAt = current.updatedAt

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
  const body: Record<string, unknown> = { kind: current.kind, timezone: current.timezone, enabled: true, expectedUpdatedAt: current.updatedAt }
  if (current.recurrence) body.recurrence = current.recurrence
  else if (current.preset) body.preset = current.preset
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
  const body: Record<string, unknown> = { kind: current.kind, timezone: current.timezone, enabled: false, expectedUpdatedAt: current.updatedAt }
  if (current.recurrence) body.recurrence = current.recurrence
  else if (current.preset) body.preset = current.preset
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

/**
 * `2026-09-23 11:00 (+02:00) / 09:00Z`. Local first, because that is what the
 * operator asked for; UTC second, because that is what the scheduler stores.
 * Falls back to the raw timestamp if the timezone is unknown to the runtime.
 */
export function formatNextRun(nextRunAt: string, timezone: string): string {
  const at = new Date(nextRunAt)
  if (Number.isNaN(at.getTime())) return nextRunAt
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'longOffset',
    }).formatToParts(at)
    const get = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
    const offset = (get('timeZoneName').replace('GMT', '') || '+00:00')
    const local = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
    const utc = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}Z`
    return `${local} (${offset}) / ${utc}`
  } catch {
    return nextRunAt
  }
}

export function printSchedule(s: ScheduleDto): void {
  console.log(`  Kind:      ${s.kind}`)
  // Only show the friendly preset name when set — without this guard, schedules
  // configured via `--cron` print the cron expression twice (once on this line,
  // once on the next).
  if (s.preset) {
    console.log(`  Preset:    ${s.preset}`)
  }
  if (s.recurrence) {
    console.log(`  Every:     ${s.recurrence.everyDays} day(s)`)
    console.log(`  Start:     ${s.recurrence.startDate}`)
    console.log(`  At:        ${s.recurrence.time}`)
  } else {
    console.log(`  Cron:      ${s.cronExpr}`)
  }
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
    // Render in the schedule's own timezone beside UTC. A bare ISO string made
    // a wrong timezone invisible: the operator had to convert in their head to
    // notice the run was hours off.
    console.log(`  Next run:  ${formatNextRun(s.nextRunAt, s.timezone)}`)
  }
}
