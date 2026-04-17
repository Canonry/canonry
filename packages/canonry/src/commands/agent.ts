import { createApiClient } from '../client.js'
import { AGENT_WEBHOOK_EVENTS } from '../agent-webhook.js'

export async function agentAttach(opts: { project: string; url: string; format?: string }): Promise<void> {
  const client = createApiClient()

  const existing = await client.listNotifications(opts.project)
  const hasAgent = existing.some(n => n.source === 'agent')
  if (hasAgent) {
    if (opts.format === 'json') {
      console.log(JSON.stringify({ status: 'already-attached', project: opts.project }))
    } else {
      console.log(`Agent webhook already attached to "${opts.project}"`)
    }
    return
  }

  const result = await client.createNotification(opts.project, {
    channel: 'webhook',
    url: opts.url,
    events: [...AGENT_WEBHOOK_EVENTS],
    source: 'agent',
  })

  if (opts.format === 'json') {
    console.log(JSON.stringify({ status: 'attached', project: opts.project, notificationId: result.id }))
  } else {
    console.log(`Agent webhook attached to "${opts.project}" (${opts.url})`)
  }
}

export async function agentDetach(opts: { project: string; format?: string }): Promise<void> {
  const client = createApiClient()

  const existing = await client.listNotifications(opts.project)
  const agentNotif = existing.find(n => n.source === 'agent')
  if (!agentNotif) {
    if (opts.format === 'json') {
      console.log(JSON.stringify({ status: 'not-attached', project: opts.project }))
    } else {
      console.log(`No agent webhook found on "${opts.project}"`)
    }
    return
  }

  await client.deleteNotification(opts.project, agentNotif.id)

  if (opts.format === 'json') {
    console.log(JSON.stringify({ status: 'detached', project: opts.project }))
  } else {
    console.log(`Agent webhook detached from "${opts.project}"`)
  }
}
