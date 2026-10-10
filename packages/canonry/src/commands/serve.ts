import { and, asc, eq, ne } from 'drizzle-orm'

import { loadConfig } from '../config.js'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { allowsKeylessFirstRunSetup, createServer, isLoopbackBindHost, waitForServerRuntimeStartup } from '../server.js'
import { closeWithIdleSweep } from '../server-shutdown.js'
import { trackEvent, setTelemetrySource } from '../telemetry.js'
import { cliRuntimeContext } from '../runtime-context.js'
import { CliError, type CliFormat, isMachineFormat } from '../cli-error.js'
import { repairAiReferralPathsOnStartup, repairNormalizedPathsOnStartup } from '../startup-path-repairs.js'
import { getMissingUserSkillsNudge, shouldPrintServeSkillsNudge } from './skills.js'
import { getPrintedUpdateAvailable } from '../update-check.js'
import { detectCanonryAgentPlugin } from '../agent-plugin.js'
import { describeError, RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { operatorHttpUrl } from '../operator-url.js'
import { resolveServePort } from '../serve-endpoint.js'
import { installAttribution } from '../telemetry-environment.js'
import { reportPreviousServerCrash, trackServerStartFailure, watchServerCrashes } from '../server-crash-telemetry.js'
import { registeredProviderNames } from '../provider-registration.js'

/** Read persisted scan state for the startup guidance. */
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
    let scanned: Set<string>
    try {
      // Probe runs are excluded for the same reason the scan-history endpoint
      // excludes them: a probe is not a scan the operator asked for, and it
      // leaves nothing for them to read.
      const audits = db.select({
        projectId: runs.projectId,
        status: runs.status,
      }).from(runs)
        .where(and(
          eq(runs.kind, RunKinds['site-audit']),
          ne(runs.trigger, RunTriggers.probe),
        ))
        .all()
      scanned = new Set(
        audits
          .filter(run => run.status === RunStatuses.completed || run.status === RunStatuses.partial)
          .map(run => run.projectId),
      )
    } catch {
      // Without the run list there is no evidence this install is unscanned.
      // Telling an operator who already has results to run their FIRST scan is
      // a worse answer than sending them to the dashboard root.
      return { projectCount: rows.length, firstProjectName: rows[0]?.name, hasSiteAudit: true }
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
function buildServeOpenLine(input: {
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
  try {
    migrate(db)
  } catch (err) {
    trackServerStartFailure(err, 'MIGRATION_FAILED')
    throw err
  }

  // Repair historical paths once per normalization version. Successful
  // passes are recorded in this database; failed passes retry next startup.
  try {
    const result = await repairNormalizedPathsOnStartup(db)
    if (result && result.updated > 0 && format === 'text') {
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

  // Keep a separate completion marker so one failed repair does not rerun
  // the other table's successful pass on every restart.
  try {
    const result = await repairAiReferralPathsOnStartup(db)
    if (result && result.updated > 0 && format === 'text') {
      console.log(
        `Migrated ${result.updated} GA AI referral row${result.updated === 1 ? '' : 's'} to canonical form.`,
      )
    }
  } catch (err) {
    const msg = describeError(err)
    process.stderr.write(`warning: ai-referral-paths backfill skipped: ${msg}\n`)
  }

  // Create and start server. Pass the bind host so the server can require the
  // root API key for first-run dashboard password setup when exposed off-box.
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
      // First-run password setup needs the root API key on every non-loopback
      // bind, and on a loopback bind whose config names another way in.
      if (!allowsKeylessFirstRunSetup(app)) {
        console.log(isLoopbackBindHost(host)
          ? 'This server is configured to be reached through a proxy or external URL (publicUrl, apiUrl, basePath, or CANONRY_TRUST_PROXY), so first-run dashboard password setup requires the root API key (apiKey in config.yaml).'
          : 'This server is not bound to loopback, so first-run dashboard password setup requires the root API key (apiKey in config.yaml).')
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

    watchServerCrashes()
    reportPreviousServerCrash()
    const providerNames = registeredProviderNames(config)
    trackEvent('serve.started', {
      providerCount: providerNames.length,
      providers: providerNames,
      ...installAttribution(),
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
    trackServerStartFailure(err)
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
