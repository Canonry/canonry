// Runs one task with several agents, each in its own isolated page, and judges every run.

import path from 'node:path'
import type { AgentBrowserAgent, AgentBrowserResultStatus } from '@canonry/canonry-contracts'
import { AgentBrowserAgents, describeError } from '@canonry/canonry-contracts'
import { BrowserSession, type CapturedWrite, type ChromeEndpoint, type EgressCheck, type Viewport } from './browser.js'
import { emptyUsage, runClaudeA11yAgent, runClaudeAgent, runGeminiAgent, runOpenAIAgent, type AgentRunInput, type AgentRunOutput, type AgentUsage } from './agents.js'
import { judgeAgentRun, type CheckExpectation } from './checks.js'

export interface AgentRunSpec {
  agent: AgentBrowserAgent
  model: string
  apiKey: string
}

export interface AgentBrowserCheckInput {
  endpoint: ChromeEndpoint
  startUrl: string
  task: string
  /** Hosts of the site under test; writes to them are answered locally, other sites are blocked. */
  siteHosts: string[]
  /** The host's outbound address policy; a request it refuses never leaves the browser. */
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

async function runOne(input: AgentBrowserCheckInput, spec: AgentRunSpec, attempt: number): Promise<AgentBrowserRunResult> {
  const evidenceDir = input.evidenceDir ? path.join(input.evidenceDir, `${spec.agent}-${attempt}`) : null
  let session: BrowserSession | null = null
  let out: AgentRunOutput | null = null
  let error: string | null = null
  let finalUrl = ''
  const started = Date.now()
  try {
    session = await BrowserSession.open({ endpoint: input.endpoint, siteHosts: input.siteHosts, egress: input.egress, viewport: input.viewport, outDir: evidenceDir })
    await session.navigate(input.startUrl)
    const runStarted = Date.now()
    out = await RUNNERS[spec.agent]({
      session,
      startUrl: input.startUrl,
      task: input.task,
      model: spec.model,
      apiKey: spec.apiKey,
      deadline: runStarted + input.maxMinutesPerRun * 60_000,
      maxTurns: input.maxTurnsPerRun,
      signal: input.signal,
    })
  } catch (err) {
    error = describeError(err)
  }
  if (session) finalUrl = await session.url().catch(() => session?.visited.at(-1) ?? '')
  const observed = { finalUrl, writes: session?.writes ?? [] }
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
    await writeFile(path.join(evidenceDir, 'actions.json'), JSON.stringify(session.log, null, 1)).catch(() => undefined)
  }
  await session?.close()
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
