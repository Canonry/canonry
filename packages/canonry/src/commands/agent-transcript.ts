import { loadConfig } from '../config.js'

export interface AgentTranscriptOptions {
  project: string
  format?: string
}

export async function agentTranscript(opts: AgentTranscriptOptions): Promise<void> {
  const config = loadConfig()
  const apiUrl = config.apiUrl.replace(/\/$/, '')
  const url = `${apiUrl}/api/v1/projects/${encodeURIComponent(opts.project)}/agent/transcript`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`Transcript fetch failed: ${res.status} ${body}`)
    process.exitCode = 2
    return
  }
  const transcript = (await res.json()) as {
    messages: Array<{ role: string; content: unknown; timestamp?: number }>
    modelProvider: string | null
    modelId: string | null
    updatedAt: string | null
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(transcript, null, 2))
    return
  }

  if (transcript.messages.length === 0) {
    console.log(`No Aero conversation yet for "${opts.project}".`)
    return
  }

  console.log(
    `Aero session for ${opts.project} — ${transcript.modelProvider ?? 'unknown'}/${transcript.modelId ?? 'unknown'} — updated ${transcript.updatedAt ?? 'never'}`,
  )
  console.log(`${transcript.messages.length} message${transcript.messages.length === 1 ? '' : 's'}\n`)

  for (const msg of transcript.messages) {
    console.log(`[${msg.role}]`)
    if (typeof msg.content === 'string') {
      console.log(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        const t = block.type as string
        if (t === 'text') console.log(block.text as string)
        else if (t === 'toolCall') console.log(`⟐ ${block.name} ${JSON.stringify(block.arguments)}`)
        else if (t === 'toolResult') console.log(`  ${(block as { isError?: boolean }).isError ? '✗' : '✓'} tool-result`)
      }
    }
    console.log()
  }
}

export async function agentTranscriptReset(opts: AgentTranscriptOptions): Promise<void> {
  const config = loadConfig()
  const apiUrl = config.apiUrl.replace(/\/$/, '')
  const url = `${apiUrl}/api/v1/projects/${encodeURIComponent(opts.project)}/agent/transcript`

  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${config.apiKey}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`Transcript reset failed: ${res.status} ${body}`)
    process.exitCode = 2
    return
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify({ status: 'reset', project: opts.project }))
  } else {
    console.log(`Aero conversation reset for "${opts.project}".`)
  }
}
