import { loadConfig } from '../config.js'
import { createClient, migrate } from '@ainyc/canonry-db'
import { createServer } from '../server.js'
import { trackEvent } from '../telemetry.js'
import { CliError, type CliFormat } from '../cli-error.js'

export async function serveCommand(format: CliFormat = 'text'): Promise<void> {
  const config = loadConfig()
  const port = parseInt(process.env.CANONRY_PORT ?? '4100', 10)
  const host = process.env.CANONRY_HOST ?? '127.0.0.1'
  config.port = port

  // Create DB client and run migrations
  const db = createClient(config.database)
  migrate(db)

  // Create and start server
  const app = await createServer({ config, db })

  try {
    await app.listen({ host, port })
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`

    if (format === 'json') {
      console.log(JSON.stringify({
        started: true,
        host,
        port,
        url,
      }, null, 2))
    } else {
      console.log(`\nCanonry server running at ${url}`)
      console.log('Press Ctrl+C to stop.\n')
    }

    const providerNames = Object.keys(config.providers ?? {}).filter(
      k => config.providers?.[k as keyof typeof config.providers]?.apiKey || config.providers?.[k as keyof typeof config.providers]?.baseUrl,
    )
    trackEvent('serve.started', {
      providerCount: providerNames.length,
      providers: providerNames,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new CliError({
      code: 'SERVE_START_FAILED',
      message: `Failed to start server: ${message}`,
      displayMessage: `Failed to start server: ${message}`,
      details: {
        host,
        port,
      },
    })
  }
}
