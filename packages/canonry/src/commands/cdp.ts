import { loadConfig, saveConfig } from '../config.js'
import { createApiClient } from '../client.js'
import { CliError } from '../cli-error.js'

function getClient() {
  return createApiClient()
}

/**
 * canonry cdp connect --host <host> --port <port>
 * Saves CDP endpoint to ~/.canonry/config.yaml
 */
export async function cdpConnect(opts: { host?: string; port?: string; format?: string }): Promise<void> {
  const config = loadConfig()
  const host = opts.host ?? 'localhost'
  const port = parseInt(opts.port ?? '9222', 10)

  config.cdp = {
    ...config.cdp,
    host,
    port,
  }
  saveConfig(config)

  if (opts.format === 'json') {
    console.log(JSON.stringify({
      host,
      port,
      endpoint: `ws://${host}:${port}`,
      restartRequired: true,
    }, null, 2))
    return
  }

  console.log(`CDP endpoint configured: ws://${host}:${port}`)
  console.log('Restart canonry server for changes to take effect.')
}

/**
 * canonry cdp status
 * Check CDP connection health + tab status
 */
export async function cdpStatus(format?: string): Promise<void> {
  const client = getClient()
  try {
    const status = await client.getCdpStatus() as {
      connected: boolean
      endpoint: string
      version?: string
      browserVersion?: string
      targets: { name: string; alive: boolean; lastUsed: string | null }[]
    }

    if (format === 'json') {
      console.log(JSON.stringify(status, null, 2))
      return
    }

    if (status.connected) {
      console.log(`CDP connected: ${status.endpoint}`)
      if (status.browserVersion) console.log(`Browser: ${status.browserVersion}`)
      if (status.targets?.length) {
        console.log('\nTargets:')
        for (const t of status.targets) {
          const status_label = t.alive ? '● alive' : '○ idle'
          const lastUsed = t.lastUsed ? ` (last used: ${t.lastUsed})` : ''
          console.log(`  ${t.name}: ${status_label}${lastUsed}`)
        }
      }
    } else {
      console.log(`CDP not connected at ${status.endpoint}`)
      console.log('Launch Chrome with: chrome --remote-debugging-port=9222')
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('501') || msg.includes('not configured')) {
      if (format === 'json') {
        console.log(JSON.stringify({
          connected: false,
          endpoint: '',
          targets: [],
        }, null, 2))
        return
      }
      console.log('CDP not configured. Run: canonry cdp connect --host <host> --port <port>')
    } else {
      throw new CliError({
        code: 'CDP_STATUS_FAILED',
        message: `Error checking CDP status: ${msg}`,
        displayMessage: `Error checking CDP status: ${msg}`,
      })
    }
  }
}

/**
 * canonry cdp targets
 * Show per-target status + last seen
 */
export async function cdpTargets(format?: string): Promise<void> {
  // Same as status but focused on targets
  await cdpStatus(format)
}

/**
 * canonry cdp screenshot <query> [--targets chatgpt]
 * One-off screenshot across CDP targets
 */
export async function cdpScreenshot(query: string, opts?: { targets?: string; format?: string }): Promise<void> {
  if (!query) {
    throw new CliError({
      code: 'CLI_USAGE_ERROR',
      message: 'query is required',
      displayMessage: 'Error: query is required\nUsage: canonry cdp screenshot "best coffee in NYC"',
      details: {
        command: 'cdp.screenshot',
        usage: 'canonry cdp screenshot "best coffee in NYC"',
      },
    })
  }

  const client = getClient()
  const body: Record<string, unknown> = { query }
  if (opts?.targets) {
    body.targets = opts.targets.split(',').map(s => s.trim())
  }

  try {
    const response = await client.cdpScreenshot(query, body.targets as string[] | undefined) as {
      results: { target: string; screenshotPath: string; answerText: string; citations: { uri: string; title: string }[] }[]
    }

    if (opts?.format === 'json') {
      console.log(JSON.stringify(response, null, 2))
      return
    }

    for (const r of response.results) {
      console.log(`\n--- ${r.target} ---`)
      console.log(`Screenshot: ${r.screenshotPath}`)
      if (r.citations.length > 0) {
        console.log('Citations:')
        for (const c of r.citations) {
          console.log(`  ${c.title}: ${c.uri}`)
        }
      } else {
        console.log('No citations found.')
      }
      if (r.answerText) {
        const preview = r.answerText.length > 200 ? r.answerText.slice(0, 200) + '...' : r.answerText
        console.log(`Answer preview: ${preview}`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new CliError({
      code: 'CDP_SCREENSHOT_FAILED',
      message: `CDP screenshot failed: ${msg}`,
      displayMessage: `CDP screenshot failed: ${msg}`,
      details: {
        query,
      },
    })
  }
}
