import { randomUUID } from 'node:crypto'
import { createApiClient } from '../client.js'
import { CliError, isMachineFormat, printCliError, type CliFormat } from '../cli-error.js'

export type ConversationAction = 'list' | 'new' | 'show' | 'resume' | 'delete'
export async function agentConversations(opts: { project: string; action: ConversationAction; id?: string; offset?: number; limit?: number; format: CliFormat }): Promise<void> {
  try {
    const client = createApiClient()
    const result = await (() => {
      switch (opts.action) {
        case 'list': return client.listAgentConversations(opts.project, { offset: opts.offset, limit: opts.limit })
        case 'new': return client.createAgentConversation(opts.project, opts.id ?? randomUUID())
        case 'show': return client.getAgentConversation(opts.project, opts.id!)
        case 'resume': return client.resumeAgentConversation(opts.project, opts.id!)
        case 'delete': return client.deleteAgentConversation(opts.project, opts.id!)
      }
    })()
    if (isMachineFormat(opts.format)) { console.log(JSON.stringify(result, null, 2)); return }
    if ('conversations' in result) {
      if (!result.conversations.length) console.log('No Aero conversations yet.')
      for (const conversation of result.conversations) console.log(`${conversation.active ? '* ' : '  '}${conversation.id}  ${conversation.title}  ${conversation.updatedAt}`)
      if (result.nextOffset !== null) console.log(`More conversations: --offset ${result.nextOffset}`)
    } else if ('messages' in result) {
      console.log(`${result.title} — ${result.id}${result.active ? ' (current)' : ''}`)
      for (const message of result.messages) console.log(`[${message.role}] ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`)
    } else console.log(`Conversation deleted: ${result.id}. Shared project notes kept.`)
  } catch (error) {
    printCliError(error, opts.format)
    process.exitCode = error instanceof CliError ? error.exitCode : 2
  }
}
