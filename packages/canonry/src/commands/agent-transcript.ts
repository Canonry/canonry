import { CliError, isMachineFormat, printCliError, type CliFormat } from '../cli-error.js'
import { createApiClient } from '../client.js'

export interface AgentTranscriptOptions {
  project: string
  format?: string
}

/**
 * Coerce the raw format flag while preserving `jsonl` — without this the local
 * 2-value coercion silently routed `--format jsonl` to human text.
 */
function toFormat(raw?: string): CliFormat {
  if (raw === 'json') return 'json'
  if (raw === 'jsonl') return 'jsonl'
  return 'text'
}

export async function agentTranscript(opts: AgentTranscriptOptions): Promise<void> {
  const format = toFormat(opts.format)
  try {
    const client = createApiClient()
    const transcript = await client.getAgentTranscript(opts.project)

    // Single transcript object (not a list) — both machine formats emit the
    // same JSON document rather than falling through to human text on jsonl.
    if (isMachineFormat(format)) {
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
  } catch (err) {
    printCliError(err, format)
    if (err instanceof CliError) process.exitCode = err.exitCode
    else process.exitCode = 2
  }
}

export async function agentTranscriptReset(opts: AgentTranscriptOptions): Promise<void> {
  const format = toFormat(opts.format)
  try {
    const client = createApiClient()
    await client.resetAgentTranscript(opts.project)
    // Single-object result — both machine formats emit the same JSON.
    if (isMachineFormat(format)) {
      console.log(JSON.stringify({ status: 'reset', project: opts.project }))
    } else {
      console.log(`Aero conversation reset for "${opts.project}".`)
    }
  } catch (err) {
    printCliError(err, format)
    if (err instanceof CliError) process.exitCode = err.exitCode
    else process.exitCode = 2
  }
}
