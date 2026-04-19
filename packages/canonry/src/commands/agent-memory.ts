import { CliError, printCliError, type CliFormat } from '../cli-error.js'
import { createApiClient } from '../client.js'

function toFormat(raw?: string): CliFormat {
  return (raw === 'json' ? 'json' : 'text') as CliFormat
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

    if (format === 'json') {
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

    if (format === 'json') {
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
