import { loadConfig } from '../config.js'
import { createClient, migrate } from '@ainyc/canonry-db'
import { createServer } from '../server.js'
import { trackEvent } from '../telemetry.js'
import { CliError, type CliFormat } from '../cli-error.js'
import { backfillAiReferralPaths, backfillNormalizedPaths } from './backfill.js'

/**
 * Precedence: `CANONRY_PORT` env var (also set by `--port`) > config.yaml `port:` > 4100.
 * Exported for tests; `serveCommand` is the only caller.
 */
export function resolveServePort(envPort: string | undefined, configPort: number | undefined): number {
  const trimmed = envPort?.trim()
  if (trimmed) return parseInt(trimmed, 10)
  return configPort ?? 4100
}

export async function serveCommand(format: CliFormat = 'text'): Promise<void> {
  const config = loadConfig()
  const port = resolveServePort(process.env.CANONRY_PORT, config.port)
  const host = process.env.CANONRY_HOST ?? '127.0.0.1'
  config.port = port

  // Create DB client and run migrations
  const db = createClient(config.database)
  migrate(db)

  // Auto-backfill landing_page_normalized for any rows still null after
  // migration v44. Idempotent: only touches rows with null normalized,
  // returns immediately when there's nothing to do. Without this, click-
  // ID-fragmented historical rows in ga_traffic_snapshots would only
  // collapse in dashboards after the user manually ran
  // `canonry backfill normalized-paths`.
  try {
    const result = backfillNormalizedPaths(db)
    if (result.updated > 0 && format === 'text') {
      console.log(
        `Migrated ${result.updated} GA landing-page row${result.updated === 1 ? '' : 's'} to canonical form.`,
      )
    }
  } catch (err) {
    // Don't block startup on backfill failure — the manual CLI command
    // remains available, and the dashboards remain partially correct
    // via COALESCE for non-fragmented legacy rows.
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`warning: normalized-path backfill skipped: ${msg}\n`)
  }

  // Same idea for ga_ai_referrals — landing_page_normalized was added in
  // v46. Without this, the dashboard's "Known AI referrers — landing pages"
  // panel surfaces legacy rows as a synthetic '(not set)' bucket until the
  // user re-syncs.
  try {
    const result = backfillAiReferralPaths(db)
    if (result.updated > 0 && format === 'text') {
      console.log(
        `Migrated ${result.updated} GA AI referral row${result.updated === 1 ? '' : 's'} to canonical form.`,
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`warning: ai-referral-paths backfill skipped: ${msg}\n`)
  }

  // Create and start server
  const app = await createServer({ config, db })

  // Graceful shutdown on SIGTERM (sent by `canonry stop`) and SIGINT (Ctrl+C)
  // Guard against double-fire: rapid Ctrl+C or concurrent SIGTERM+SIGINT
  // would call app.close() multiple times, causing unhandled rejections.
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    if (format === 'text') {
      console.log(`\nReceived ${signal}, stopping server...`)
    }
    app.close().then(() => {
      process.exit(0)
    }).catch((err) => {
      console.error('Error during shutdown:', err)
      process.exit(1)
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

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
