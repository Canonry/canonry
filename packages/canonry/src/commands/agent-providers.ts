import { CliError, printCliError, type CliFormat } from '../cli-error.js'
import { createApiClient } from '../client.js'

export interface AgentProvidersOptions {
  project: string
  format?: string
}

/**
 * Lists the providers Aero can route to for a given project — parity with the
 * dashboard's provider picker so agents can discover which keys are wired up
 * without opening the UI.
 */
export async function agentProviders(opts: AgentProvidersOptions): Promise<void> {
  const format = (opts.format === 'json' ? 'json' : 'text') as CliFormat
  try {
    const client = createApiClient()
    const res = await client.listAgentProviders(opts.project)

    if (format === 'json') {
      console.log(JSON.stringify(res, null, 2))
      return
    }

    console.log(
      `Aero providers for ${opts.project} (default: ${res.defaultProvider ?? 'none configured'})\n`,
    )
    const idWidth = Math.max(...res.providers.map((p) => p.id.length), 8)
    for (const p of res.providers) {
      const status = p.configured ? '✓' : '✗'
      const source = p.keySource ? `(${p.keySource})` : ''
      console.log(
        `  ${status} ${p.id.padEnd(idWidth)}  ${p.label}  — model ${p.defaultModel} ${source}`.trimEnd(),
      )
    }
  } catch (err) {
    printCliError(err, format)
    if (err instanceof CliError) process.exitCode = err.exitCode
    else process.exitCode = 2
  }
}
