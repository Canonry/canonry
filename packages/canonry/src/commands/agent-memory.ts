import { CliError, isMachineFormat, printCliError, type CliFormat } from '../cli-error.js'
import { createApiClient } from '../client.js'
import { emitJsonl } from '../cli-output.js'

function toFormat(raw?: string): CliFormat {
  // Preserve `jsonl` so the agent-friendly machine format isn't silently
  // coerced to `text` — json → json, jsonl → jsonl, anything else → text.
  if (raw === 'json') return 'json'
  if (raw === 'jsonl') return 'jsonl'
  return 'text'
}

export interface AgentMemoryListOptions {
  project: string
  format?: string
}

export async function agentMemoryList(opts: AgentMemoryListOptions): Promise<void> {
  const format = toFormat(opts.format)
  try {
    const client = createApiClient()
    const result = await client.listAgentMemory(opts.project)

    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2))
      return
    } else if (format === 'jsonl') {
      // One self-contained note per line, prefixed with the project it belongs
      // to so a line lifted out of context still says which project it scopes.
      emitJsonl(result.entries.map((entry) => ({ project: opts.project, ...entry })))
      return
    }

    if (result.entries.length === 0) {
      console.log(`No Aero memory notes for "${opts.project}".`)
      return
    }

    console.log(`Aero memory for ${opts.project} — ${result.entries.length} note(s)\n`)
    for (const entry of result.entries) {
      console.log(`[${entry.source}] ${entry.key}  (updated ${entry.updatedAt})`)
      console.log(`  ${entry.value.replace(/\n/g, '\n  ')}`)
      console.log()
    }
  } catch (err) {
    printCliError(err, format)
    process.exitCode = err instanceof CliError ? err.exitCode : 2
  }
}

export interface AgentMemorySetOptions {
  project: string
  key: string
  value: string
  format?: string
}

export async function agentMemorySet(opts: AgentMemorySetOptions): Promise<void> {
  const format = toFormat(opts.format)
  try {
    const client = createApiClient()
    const result = await client.setAgentMemory(opts.project, {
      key: opts.key,
      value: opts.value,
    })

    // Single-object mutation: both machine formats emit the same JSON object
    // (never silently fall through to human text on `--format jsonl`).
    if (isMachineFormat(format)) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    console.log(`Stored note "${result.entry.key}" for "${opts.project}" (source=${result.entry.source}).`)
  } catch (err) {
    printCliError(err, format)
    process.exitCode = err instanceof CliError ? err.exitCode : 2
  }
}

export interface AgentMemoryForgetOptions {
  project: string
  key: string
  format?: string
}

export async function agentMemoryForget(opts: AgentMemoryForgetOptions): Promise<void> {
  const format = toFormat(opts.format)
  try {
    const client = createApiClient()
    const result = await client.forgetAgentMemory(opts.project, opts.key)

    // Single-object mutation: both machine formats emit the same JSON object.
    if (isMachineFormat(format)) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    if (result.status === 'forgotten') {
      console.log(`Forgot note "${opts.key}" for "${opts.project}".`)
    } else {
      console.log(`No note with key "${opts.key}" for "${opts.project}".`)
    }
  } catch (err) {
    printCliError(err, format)
    process.exitCode = err instanceof CliError ? err.exitCode : 2
  }
}
