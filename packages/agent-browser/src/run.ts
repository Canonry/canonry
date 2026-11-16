// Runs one task with several agents, each in its own isolated page, and judges every run.

import path from 'node:path'
import type { AgentBrowserAgent, AgentBrowserResultStatus } from '@canonry/canonry-contracts'
import { AgentBrowserAgents, describeError } from '@canonry/canonry-contracts'
import { BrowserSession, launchChrome, type ActionLogEntry, type CapturedWrite, type ChromeHandle, type Viewport } from './browser.js'
import { createEgressGate, startEgressProxy, type EgressCheck, type EgressProxy } from './egress-proxy.js'
import { emptyUsage, runClaudeA11yAgent, runClaudeAgent, runGeminiAgent, runOpenAIAgent, type AgentRunInput, type AgentRunOutput, type AgentUsage } from './agents.js'
import { judgeAgentRun, type CheckExpectation } from './checks.js'

export interface AgentRunSpec {
  agent: AgentBrowserAgent
  model: string
  apiKey: string
}

export interface AgentBrowserCheckInput {
  /** The Chrome or Chromium to launch: one browser per agent run, behind that run's egress proxy. */
  chromePath: string
  startUrl: string
  task: string
  /** Hosts of the site under test; writes to them are answered locally, other sites are blocked. */
  siteHosts: string[]
  /** The host's outbound address policy. Each run's proxy dials only the addresses it vets. */
  egress: EgressCheck
  agents: AgentRunSpec[]
  /** Runs per agent. Agents vary from run to run, so more than one shows how reliable a result is. */
  repeats: number
  expect: CheckExpectation
  /** Wall-clock budget for one agent run. */
  maxMinutesPerRun: number
  maxTurnsPerRun: number
  /** Screenshots and action logs go under here, one folder per run; null keeps nothing. */
  evidenceDir: string | null
  concurrency: number
  viewport?: Viewport
  signal?: AbortSignal
  onResult?: (result: AgentBrowserRunResult) => void
}

export interface AgentBrowserRunResult {
  agent: AgentBrowserAgent
  model: string
  attempt: number
  status: AgentBrowserResultStatus
  /** True when the status was checked against expectations; false when it rests on the agent's claim. */
  verified: boolean
  detail: string
  checks: Array<{ check: string; passed: boolean; detail: string }>
  answer: string
  stop: string
  error: string | null
  durationMs: number
  turns: number
  actions: number
  screenshots: number
  usage: AgentUsage
  safetyChecks: number
  finalUrl: string
  visited: string[]
  blockedPages: string[]
  writes: CapturedWrite[]
  evidenceDir: string | null
}

const RUNNERS: Record<AgentBrowserAgent, (input: AgentRunInput) => Promise<AgentRunOutput>> = {
  [AgentBrowserAgents.openai]: runOpenAIAgent,
  [AgentBrowserAgents.claude]: runClaudeAgent,
  [AgentBrowserAgents.gemini]: runGeminiAgent,
  [AgentBrowserAgents['claude-a11y']]: runClaudeA11yAgent,
}

/** Extra time past a run's deadline before its browser is shut to free a call stuck in it. */
const STUCK_GRACE_MS = 30_000

async function runOne(input: AgentBrowserCheckInput, spec: AgentRunSpec, attempt: number): Promise<AgentBrowserRunResult> {
  const evidenceDir = input.evidenceDir ? path.join(input.evidenceDir, `${spec.agent}-${attempt}`) : null
  let session: BrowserSession | null = null
  let chrome: ChromeHandle | null = null
  let proxy: EgressProxy | null = null
  let out: AgentRunOutput | null = null
  let error: string | null = null
  let finalUrl = ''
  const refused: ActionLogEntry[] = []
  const started = Date.now()
  // The wall-clock limit aborts the run's provider calls and browser work, not only new turns.
  const limit = new AbortController()
  const signal = input.signal ? AbortSignal.any([input.signal, limit.signal]) : limit.signal
  const timers: NodeJS.Timeout[] = []
  try {
    const gate = createEgressGate(input.egress)
    proxy = await startEgressProxy(gate, (target, reason) => refused.push({ at: Date.now(), action: { event: 'egress-refused', target, reason } }))
    chrome = await launchChrome(input.chromePath, input.viewport, { proxyServer: proxy.url })
    session = await BrowserSession.open({ endpoint: chrome.endpoint, siteHosts: input.siteHosts, gate, viewport: input.viewport, outDir: evidenceDir })
    await session.navigate(input.startUrl)
    const deadline = Date.now() + input.maxMinutesPerRun * 60_000
    timers.push(setTimeout(() => limit.abort(new Error('The run reached its time limit.')), deadline - Date.now()))
    // A call stuck inside the browser ignores the signal; closing the browser frees it.
    const stuck = chrome
    timers.push(setTimeout(() => void stuck.close(), deadline - Date.now() + STUCK_GRACE_MS))
    out = await RUNNERS[spec.agent]({
      session,
      startUrl: input.startUrl,
      task: input.task,
      model: spec.model,
      apiKey: spec.apiKey,
      deadline,
      maxTurns: input.maxTurnsPerRun,
      signal,
    })
  } catch (err) {
    // Past the deadline, a failure is the time limit taking effect, not a broken run.
    if (limit.signal.aborted && !input.signal?.aborted) out = { answer: '', turns: 0, actions: 0, stop: 'time-limit', usage: emptyUsage(), safetyChecks: 0 }
    else error = describeError(err)
  } finally {
    for (const timer of timers) clearTimeout(timer)
  }
  if (session) finalUrl = await session.url().catch(() => session?.visited.at(-1) ?? '')
  const observed = { finalUrl, writes: session?.writes ?? [], blockedPages: session?.blockedPages ?? [], siteHosts: input.siteHosts }
  const verdict = judgeAgentRun(out, error, observed, input.expect)
  const result: AgentBrowserRunResult = {
    agent: spec.agent,
    model: spec.model,
    attempt,
    ...verdict,
    answer: out?.answer ?? '',
    stop: out?.stop ?? 'error',
    error,
    durationMs: Date.now() - started,
    turns: out?.turns ?? 0,
    actions: out?.actions ?? 0,
    screenshots: session?.screenshots ?? 0,
    usage: out?.usage ?? emptyUsage(),
    safetyChecks: out?.safetyChecks ?? 0,
    finalUrl,
    visited: session?.visited ?? [],
    blockedPages: session?.blockedPages ?? [],
    writes: session?.writes ?? [],
    evidenceDir,
  }
  if (evidenceDir && session) {
    const { writeFile } = await import('node:fs/promises')
    const log = [...session.log, ...refused].sort((a, b) => a.at - b.at)
    await writeFile(path.join(evidenceDir, 'actions.json'), JSON.stringify(log, null, 1)).catch(() => undefined)
  }
  await session?.close().catch(() => undefined)
  await chrome?.close().catch(() => undefined)
  await proxy?.close().catch(() => undefined)
  return result
}

/** Runs every agent `repeats` times, at most `concurrency` at once, and returns every result. */
export async function runAgentBrowserCheck(input: AgentBrowserCheckInput): Promise<AgentBrowserRunResult[]> {
  const jobs: Array<{ spec: AgentRunSpec; attempt: number }> = []
  for (let attempt = 1; attempt <= Math.max(1, input.repeats); attempt += 1) for (const spec of input.agents) jobs.push({ spec, attempt })
  const results: AgentBrowserRunResult[] = []
  let next = 0
  const worker = async () => {
    while (next < jobs.length && !input.signal?.aborted) {
      const job = jobs[next]
      next += 1
      const result = await runOne(input, job.spec, job.attempt)
      results.push(result)
      input.onResult?.(result)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency, jobs.length)) }, worker))
  return results.sort((a, b) => a.agent.localeCompare(b.agent) || a.attempt - b.attempt)
}
