import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

interface NotificationResponse {
  id: string
  projectId: string
  channel: string
  url: string
  events: string[]
  enabled: boolean
}

export async function addNotification(project: string, opts: {
  webhook: string
  events: string[]
}): Promise<void> {
  const client = getClient()
  const result = await client.createNotification(project, {
    channel: 'webhook',
    url: opts.webhook,
    events: opts.events,
  }) as NotificationResponse

  console.log(`Notification created for "${project}":`)
  printNotification(result)
}

export async function listNotifications(project: string): Promise<void> {
  const client = getClient()
  const results = await client.listNotifications(project) as NotificationResponse[]
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

export async function removeNotification(project: string, id: string): Promise<void> {
  const client = getClient()
  await client.deleteNotification(project, id)
  console.log(`Notification ${id} removed from "${project}"`)
}

export async function testNotification(project: string, id: string): Promise<void> {
  const client = getClient()
  const result = await client.testNotification(project, id) as { status: number; ok: boolean }
  if (result.ok) {
    console.log(`Test webhook delivered successfully (HTTP ${result.status})`)
  } else {
    console.error(`Test webhook failed: HTTP ${result.status}`)
  }
}

function printNotification(n: NotificationResponse): void {
  console.log(`  ID:      ${n.id}`)
  console.log(`  Channel: ${n.channel}`)
  console.log(`  URL:     ${n.url}`)
  console.log(`  Events:  ${n.events.join(', ')}`)
  console.log(`  Enabled: ${n.enabled ? 'yes' : 'no'}`)
}
