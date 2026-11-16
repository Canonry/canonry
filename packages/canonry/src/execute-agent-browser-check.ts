// Runs one agent-browser check: AI agents try a task on the project's site in a real browser.
// The route created the run row and stored the normalized request; this claims the run, finds
// a Chrome, runs every agent in its own isolated page, and records each agent run as it ends.

import crypto from 'node:crypto'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { agentBrowserChecks, agentBrowserResults, runs } from '@canonry/canonry-db'
import type { DatabaseClient } from '@canonry/canonry-db'
import {
  AGENT_BROWSER_AGENT_PROFILES,
  AgentBrowserResultStatuses,
  RunStatuses,
  describeError,
  summarizeAgentBrowserResults,
} from '@canonry/canonry-contracts'
import type { AgentBrowserAgent, AgentBrowserEffectiveRequest, AgentBrowserResultStatus, RunStatus } from '@canonry/canonry-contracts'
import {
  connectedChrome,
  emptyUsage,
  findChromeExecutable,
  launchChrome,
  runAgentBrowserCheck,
} from '@canonry/canonry-agent-browser'
import type { AgentBrowserRunResult, AgentRunSpec, ChromeHandle } from '@canonry/canonry-agent-browser'
import { resolvePublicHttpTarget } from '@canonry/canonry-api-routes'
import { resolveApiKeyFor } from './agent/providers.js'
import { getConfigDir } from './config.js'
import type { CanonryConfig } from './config.js'
import { createLogger } from './logger.js'

const log = createLogger('AgentBrowserCheck')

/** At most this many agent runs share the browser at once. */
const MAX_CONCURRENT_RUNS = 4
const MAX_ANSWER_CHARS = 8_000
const MAX_LISTED_URLS = 100
const MAX_SUBMISSIONS = 50
const MAX_SUBMISSION_BODY_CHARS = 10_000

export interface AgentBrowserCheckOptions {
  config: Pick<CanonryConfig, 'providers' | 'cdp'>
  signal?: AbortSignal
}

/**
 * A browser for the check: a local Chrome this host can launch (found on PATH-like install
 * locations or through `CANONRY_CHROME_PATH`), else the Chrome connected with
 * `canonry cdp connect`. Each agent run still gets its own isolated browser context, so a
 * connected Chrome's signed-in sessions are never visible to a check.
 */
export async function resolveAgentBrowserChrome(config: Pick<CanonryConfig, 'cdp'>): Promise<ChromeHandle> {
  const executable = await findChromeExecutable()
  if (executable) return launchChrome(executable)
  if (config.cdp?.host || config.cdp?.port) return connectedChrome({ host: config.cdp.host ?? 'localhost', port: config.cdp.port ?? 9222 })
  throw new Error('No Chrome is available. Install Chrome or Chromium, set CANONRY_CHROME_PATH, or connect one with `canonry cdp connect`.')
}

/**
 * The check browser's outbound address policy, the same one every other gate that dials a URL
 * Canonry did not choose uses: an origin may be dialed only when every address its host
 * resolves to is public. A page on the site under test cannot load the cloud metadata
 * service, a loopback port or a private network into a screenshot.
 */
export async function agentBrowserEgress(origin: string): Promise<string | null> {
  const target = await resolvePublicHttpTarget(`${origin}/`)
  return target.ok ? null : target.message
}

const clipText = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value)

function erroredResult(agent: AgentBrowserAgent, model: string, attempt: number, message: string): AgentBrowserRunResult {
  return {
    agent,
    model,
    attempt,
    status: AgentBrowserResultStatuses.errored,
    verified: false,
    detail: message,
    checks: [],
    answer: '',
    stop: 'error',
    error: message,
    durationMs: 0,
    turns: 0,
    actions: 0,
    screenshots: 0,
    usage: emptyUsage(),
    safetyChecks: 0,
    finalUrl: '',
    visited: [],
    blockedPages: [],
    writes: [],
    evidenceDir: null,
  }
}

function recordResult(db: DatabaseClient, projectId: string, runId: string, result: AgentBrowserRunResult): void {
  db.insert(agentBrowserResults)
    .values({
      id: crypto.randomUUID(),
      projectId,
      runId,
      agent: result.agent,
      model: result.model,
      perception: AGENT_BROWSER_AGENT_PROFILES[result.agent].perception,
      attempt: result.attempt,
      status: result.status,
      verified: result.verified,
      detail: clipText(result.detail, 2_000),
      checks: result.checks,
      answer: clipText(result.answer, MAX_ANSWER_CHARS),
      stop: result.stop,
      error: result.error ? clipText(result.error, 2_000) : null,
      durationMs: Math.max(0, Math.round(result.durationMs)),
      turns: result.turns,
      actions: result.actions,
      screenshots: result.screenshots,
      safetyChecks: result.safetyChecks,
      usage: result.usage,
      finalUrl: result.finalUrl,
      visited: result.visited.slice(0, MAX_LISTED_URLS),
      blockedPages: result.blockedPages.slice(0, MAX_LISTED_URLS),
      submissions: result.writes.slice(0, MAX_SUBMISSIONS).map((w) => ({
        url: w.url,
        method: w.method,
        body: w.body === null ? null : clipText(w.body, MAX_SUBMISSION_BODY_CHARS),
        answeredLocally: w.answeredLocally,
      })),
      evidencePath: result.evidenceDir,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run()
}

/**
 * The run's final status from its results: `completed` when every agent run was judged,
 * `partial` when some errored (a provider or the browser failed), `failed` when none could be
 * judged. A failed or passed agent run is a finding about the site, so it never fails the run.
 */
export function agentBrowserRunStatus(statuses: readonly AgentBrowserResultStatus[], expected: number): RunStatus {
  const summary = summarizeAgentBrowserResults(statuses.map((status) => ({ status, verified: true })), expected)
  if (summary.results === 0 || summary.errored === summary.results) return RunStatuses.failed
  if (summary.errored > 0 || summary.results < expected) return RunStatuses.partial
  return RunStatuses.completed
}

export async function executeAgentBrowserCheck(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: AgentBrowserCheckOptions,
): Promise<void> {
  const claim = db.update(runs)
    .set({ status: RunStatuses.running, startedAt: new Date().toISOString() })
    .where(and(eq(runs.id, runId), eq(runs.projectId, projectId), eq(runs.status, RunStatuses.queued)))
    .run()
  if (claim.changes === 0) return
  let chrome: ChromeHandle | null = null
  try {
    const check = db.select().from(agentBrowserChecks).where(and(eq(agentBrowserChecks.runId, runId), eq(agentBrowserChecks.projectId, projectId))).get()
    if (!check) throw new Error('The check has no stored request.')
    // The route froze what counts as the site (the project's, or a Property's with the
    // project's), so a plan or domain change never moves a queued check.
    const request: AgentBrowserEffectiveRequest = check.request
    const target = await resolvePublicHttpTarget(request.startUrl)
    if (!target.ok) throw new Error(`The start URL is not a public web address: ${target.message}`)

    const specs: AgentRunSpec[] = []
    for (const entry of request.agents) {
      const provider = AGENT_BROWSER_AGENT_PROFILES[entry.agent].provider
      const apiKey = resolveApiKeyFor(provider, opts.config)
      if (apiKey) {
        specs.push({ agent: entry.agent, model: entry.model, apiKey })
        continue
      }
      // An agent with no key is recorded as errored for each of its runs; the others still run.
      for (let attempt = 1; attempt <= request.repeats; attempt += 1) {
        recordResult(db, projectId, runId, erroredResult(entry.agent, entry.model, attempt, `No ${provider} API key is configured for this Canonry.`))
      }
    }

    if (specs.length) {
      chrome = await resolveAgentBrowserChrome(opts.config)
      const evidenceRoot = path.join(getConfigDir(), 'agent-browser')
      await runAgentBrowserCheck({
        endpoint: chrome.endpoint,
        startUrl: request.startUrl,
        task: request.task,
        siteHosts: [...request.siteHosts],
        egress: agentBrowserEgress,
        agents: specs,
        repeats: request.repeats,
        expect: {
          ...(request.expect.urlPath !== null ? { urlPath: request.expect.urlPath } : {}),
          ...(request.expect.answerIncludes.length ? { answerIncludes: request.expect.answerIncludes } : {}),
          ...(request.expect.submitPath !== null ? { submitPath: request.expect.submitPath } : {}),
          ...(Object.keys(request.expect.submitFields).length ? { submitFields: request.expect.submitFields } : {}),
        },
        maxMinutesPerRun: request.maxMinutesPerRun,
        maxTurnsPerRun: request.maxTurnsPerRun,
        evidenceDir: path.join(evidenceRoot, runId),
        concurrency: Math.min(MAX_CONCURRENT_RUNS, specs.length * request.repeats),
        signal: opts.signal,
        onResult: (result) => recordResult(db, projectId, runId, result),
      })
    }

    if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('Cancelled by user')
    const statuses = db.select({ status: agentBrowserResults.status }).from(agentBrowserResults)
      .where(and(eq(agentBrowserResults.runId, runId), eq(agentBrowserResults.projectId, projectId))).all()
      .map((row) => row.status as AgentBrowserResultStatus)
    const status = agentBrowserRunStatus(statuses, request.agents.length * request.repeats)
    db.update(runs)
      .set({
        status,
        finishedAt: new Date().toISOString(),
        ...(status === RunStatuses.failed ? { error: 'No agent run could be judged: every one errored.' } : {}),
      })
      .where(and(eq(runs.id, runId), eq(runs.status, RunStatuses.running)))
      .run()
    log.info('finished', { runId, projectId, status, results: statuses.length })
  } catch (error) {
    const cancelled = opts.signal?.aborted === true
    const message = describeError(error)
    db.update(runs)
      .set({ status: cancelled ? RunStatuses.cancelled : RunStatuses.failed, error: message, finishedAt: new Date().toISOString() })
      .where(and(eq(runs.id, runId), eq(runs.status, RunStatuses.running)))
      .run()
    log.error('failed', { runId, projectId, cancelled, error: message })
    throw error
  } finally {
    await chrome?.close().catch(() => undefined)
  }
}
