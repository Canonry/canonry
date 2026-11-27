import { createApiClient } from '../client.js'
import { emitJsonl } from '../cli-output.js'
import { isMachineFormat, usageError } from '../cli-error.js'
import { NOTIFICATION_EVENT_DESCRIPTIONS, notificationEventSchema, type NotificationEvent } from '@canonry/canonry-contracts'

function getClient() {
  return createApiClient()
}

interface NotificationResponse {
  id: string
  projectId: string
  channel: string
  url: string
  urlDisplay?: string
  urlHost?: string
  events: string[]
  enabled: boolean
}

export async function addNotification(project: string, opts: {
  webhook: string
  events: string[]
  format?: string
}): Promise<void> {
  const client = getClient()
  const result = await client.createNotification(project, {
    channel: 'webhook',
    url: opts.webhook,
    events: opts.events,
  }) as NotificationResponse

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Notification created for "${project}":`)
  printNotification(result)
}

export async function listNotifications(project: string, format?: string): Promise<void> {
  const client = getClient()
  const results = await client.listNotifications(project) as NotificationResponse[]

  if (format === 'json') {
    console.log(JSON.stringify(results, null, 2))
    return
  } else if (format === 'jsonl') {
    // Each notification already carries `projectId`, so a line stands alone
    // when lifted out of the list — emit bare, no `project` tag to inject.
    emitJsonl(results)
    return
  }

  if (results.length === 0) {
    console.log(`No notifications configured for "${project}"`)
    return
  }

  console.log(`Notifications for "${project}":\n`)
  for (const n of results) {
    printNotification(n)
    console.log()
  }
}

export async function removeNotification(project: string, id: string, format?: string): Promise<void> {
  const client = getClient()
  await client.deleteNotification(project, id)
  if (isMachineFormat(format)) {
    console.log(JSON.stringify({ project, id, removed: true }, null, 2))
    return
  }
  console.log(`Notification ${id} removed from "${project}"`)
}

export async function updateNotification(project: string, id: string, opts: {
  events?: string[]
  addEvents?: string[]
  removeEvents?: string[]
  enabled?: boolean
  format?: string
}): Promise<void> {
  const client = getClient()
  const result = await client.updateNotification(project, id, {
    ...(opts.events ? { events: opts.events as NotificationEvent[] } : {}),
    ...(opts.addEvents ? { addEvents: opts.addEvents as NotificationEvent[] } : {}),
    ...(opts.removeEvents ? { removeEvents: opts.removeEvents as NotificationEvent[] } : {}),
    ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
  })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Notification ${id} updated for "${project}":`)
  printNotification(result)
}

export async function testNotification(project: string, id: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.testNotification(project, id) as { status: number; ok: boolean }
  if (isMachineFormat(format)) {
    console.log(JSON.stringify({ project, id, ...result }, null, 2))
    return
  }
  if (result.ok) {
    console.log(`Test webhook delivered successfully (HTTP ${result.status})`)
  } else {
    console.error(`Test webhook failed: HTTP ${result.status}`)
  }
}

export function listEvents(format?: string, target = 'local'): void | Promise<void> {
  if (target === 'server') return getClient().listNotificationEvents().then(events => printEvents(events, format))
  if (target !== 'local') throw usageError('--target must be local or server')
  printEvents(notificationEventSchema.options, format)
}

/** An event the server knows and this CLI does not (an older CLI) is listed without a description. */
function describeEvent(event: string): string {
  const known = notificationEventSchema.safeParse(event)
  return known.success ? NOTIFICATION_EVENT_DESCRIPTIONS[known.data] : ''
}

function printEvents(events: readonly string[], format?: string): void {
  const catalog = events.map(e => ({ event: e, description: describeEvent(e) }))
  if (format === 'json') {
    console.log(JSON.stringify(catalog, null, 2))
    return
  } else if (format === 'jsonl') {
    // Each record self-identifies via `event`, so it's
    // emitted bare (no project / context tag to prepend).
    emitJsonl(catalog)
    return
  }
  console.log('Available notification events:\n')
  const width = Math.max(0, ...events.map(event => event.length))
  for (const { event, description } of catalog) {
    console.log(`  ${event.padEnd(width)}  ${description}`)
  }
}

function printNotification(n: NotificationResponse): void {
  console.log(`  ID:      ${n.id}`)
  console.log(`  Channel: ${n.channel}`)
  console.log(`  URL:     ${n.urlDisplay ?? n.url}`)
  console.log(`  Events:  ${n.events.join(', ')}`)
  console.log(`  Enabled: ${n.enabled ? 'yes' : 'no'}`)
}
