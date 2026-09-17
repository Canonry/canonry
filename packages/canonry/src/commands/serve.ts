import { asc, eq } from 'drizzle-orm'

import { loadConfig } from '../config.js'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { createServer, isLoopbackBindHost, waitForServerRuntimeStartup } from '../server.js'
import { closeWithIdleSweep } from '../server-shutdown.js'
import { trackEvent, setTelemetrySource } from '../telemetry.js'
import { cliRuntimeContext } from '../runtime-context.js'
import { CliError, type CliFormat, isMachineFormat } from '../cli-error.js'
import { backfillAiReferralPaths, backfillNormalizedPaths } from './backfill.js'
import { getMissingUserSkillsNudge, shouldPrintServeSkillsNudge } from './skills.js'
import { getPrintedUpdateAvailable } from '../update-check.js'
import { detectCanonryAgentPlugin } from '../agent-plugin.js'
import { describeError } from '@ainyc/canonry-contracts'
import { operatorHttpUrl } from '../operator-url.js'
import { resolveServePort } from '../serve-endpoint.js'

/**
 * Precedence: `CANONRY_PORT` env var (also set by `--port`) > config.yaml `port:` > 4100.
 * Re-exported here to preserve the command's public test seam.
 */
export { resolveServePort } from '../serve-endpoint.js'

/** First-run password setup is loopback-only for every non-loopback bind. */
export function shouldWarnAboutRemoteSetup(host: string | undefined): boolean {
  return !isLoopbackBindHost(host)
}

function readServeOpenState(db: ReturnType<typeof createClient>): {
  projectCount: number
  firstProjectName?: string
  hasSiteAudit: boolean
} {
  try {
    const rows = db.select({
      id: projects.id,
      name: projects.name,
      createdAt: projects.createdAt,
    }).from(projects)
      .orderBy(asc(projects.createdAt), asc(projects.name))
      .all()
    if (rows.length === 0) return { projectCount: 0, hasSiteAudit: false }
    let scanned = new Set<string>()
    try {
      const audits = db.select({
        projectId: runs.projectId,
        status: runs.status,
      }).from(runs)
        .where(eq(runs.kind, 'site-audit'))
        .all()
      scanned = new Set(
        audits
          .filter(run => run.status === 'completed' || run.status === 'partial')
          .map(run => run.projectId),
      )
    } catch {
      scanned = new Set()
    }
    const firstUnscanned = rows.find(row => !scanned.has(row.id))
    if (firstUnscanned) {
      return { projectCount: rows.length, firstProjectName: firstUnscanned.name, hasSiteAudit: false }
    }
    return { projectCount: rows.length, firstProjectName: rows[0]?.name, hasSiteAudit: true }
  } catch {
    return { projectCount: 0, hasSiteAudit: false }
  }
}

/** First-run banner: empty installs and unscanned projects still point at Page Health. */
export function buildServeOpenLine(input: {
  url: string
  projectCount: number
  firstProjectName?: string
  hasSiteAudit: boolean
}): string {
  if (input.projectCount === 0) {
    return `Open ${input.url}/setup to map your site and run your first Page Health scan.`
  }
  if (!input.hasSiteAudit && input.firstProjectName) {
    return `Open ${input.url}/setup?onboarding=site-health&setupProject=${encodeURIComponent(input.firstProjectName)} to run your first Page Health scan.`
  }
  return `Open ${input.url}`
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
    const msg = describeError(err)
    process.stderr.write(`warning: normalized-path backfill skipped: ${msg}\n`)
  }

  // Same idea for ga_ai_referrals — landing_page_normalized was added in
  // v46. Without this, the dashboard's "Known AI referrers by landing page"
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
    const msg = describeError(err)
    process.stderr.write(`warning: ai-referral-paths backfill skipped: ${msg}\n`)
  }

  // Create and start server. Pass the bind host so the server can gate the
  // unauthenticated first-run dashboard password setup when exposed off-box.
  // User-global only. Project-local client settings belong to the invoking
  // coding-agent process, not to this long-running API daemon. Keep this as a
  // closure so doctor reflects plugin installs/removals without a server restart.
  const getAgentPluginState = () => detectCanonryAgentPlugin({
    home: process.env.HOME,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    codexHome: process.env.CODEX_HOME,
  })
  const app = await createServer({ config, db, host, getAgentPluginState })

  // Set the moment the server is bound and serving. Everything after that point
  // in this `try` is reporting: console output, the skills nudge, telemetry.
  // A throw there used to reach the catch below and `app.close()` a HEALTHY,
  // listening server, turning a cosmetic failure into an outage.
  let listening = false

  try {
    await app.listen({ host, port })

    // Bind succeeded: Ctrl+C must work even if scheduler startup hangs.
    let shuttingDown = false
    const shutdown = (signal: string): void => {
      if (shuttingDown) return
      shuttingDown = true
      if (format === 'text') {
        console.log(`\nReceived ${signal}, stopping server...`)
      }
      closeWithIdleSweep(app).then(() => {
        process.exit(0)
      }).catch((err) => {
        console.error('Error during shutdown:', err)
        process.exit(1)
      })
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))

    const url = operatorHttpUrl(host, port)
    if (!isMachineFormat(format)) {
      console.log(`\nCanonry server running at ${url}`)
      console.log(buildServeOpenLine({ url, ...readServeOpenState(db) }))
      if (shouldWarnAboutRemoteSetup(host)) {
        console.log('First-run dashboard password setup is unauthenticated only on loopback; complete setup from this machine first or use a bearer cnry_... key.')
      }
      console.log('Press Ctrl+C to stop.\n')
      const nudge = getMissingUserSkillsNudge(process.env.HOME, getAgentPluginState())
      if (shouldPrintServeSkillsNudge(nudge, getPrintedUpdateAvailable())) {
        process.stderr.write(`${nudge.message}\n`)
      }
    }

    await waitForServerRuntimeStartup(app)
    listening = true

    if (isMachineFormat(format)) {
      console.log(JSON.stringify({
        started: true,
        host,
        port,
        url,
      }, null, 2))
    }

    // Switch the source for the rest of this process — every event emitted
    // while `canonry serve` is running (run.completed, scheduled runs, future
    // dashboard-driven actions) needs to be distinguishable from one-shot
    // CLI events.
    setTelemetrySource('cli-server')

    const providerNames = Object.keys(config.providers ?? {}).filter(
      k => config.providers?.[k as keyof typeof config.providers]?.apiKey || config.providers?.[k as keyof typeof config.providers]?.baseUrl,
    )
    trackEvent('serve.started', {
      providerCount: providerNames.length,
      providers: providerNames,
      // Who launched the server: an agent-started install is its own funnel.
      ...cliRuntimeContext(),
    })
  } catch (err) {
    const message = describeError(err)
    if (listening) {
      // Bound and serving already. Report the failure without tearing down a
      // working server; the signal handlers are installed and own its shutdown.
      process.stderr.write(`warning: server started but post-startup reporting failed: ${message}\n`)
      return
    }
    try {
      await closeWithIdleSweep(app)
    } catch (closeErr) {
      process.stderr.write(`warning: failed to close server after startup error: ${describeError(closeErr)}\n`)
    }
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
