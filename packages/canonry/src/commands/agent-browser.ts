import type { AgentBrowserCheckDto, AgentBrowserCheckRequest, AgentBrowserResultDto } from '@canonry/canonry-contracts'
import { AgentBrowserResultStatuses, RunStatuses } from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError, EXIT_SYSTEM_ERROR, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

const TERMINAL = new Set<string>([RunStatuses.completed, RunStatuses.partial, RunStatuses.failed, RunStatuses.cancelled])

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`
const sees = (r: AgentBrowserResultDto) => (r.perception === 'accessibility-tree' ? 'accessibility tree' : 'screenshots')

function statusLabel(r: AgentBrowserResultDto): string {
  if (r.status === AgentBrowserResultStatuses.passed) return r.verified ? 'passed' : 'passed (unverified)'
  return r.status
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

/** The human view of one check: the request, the counts, then one line per agent run. */
export function renderAgentBrowserCheck(check: AgentBrowserCheckDto): string {
  const s = check.summary
  const lines = [
    `Agent-browser check ${check.runId} · ${check.status}`,
    ...(check.request.property ? [`Property: ${check.request.property.label} (${check.request.property.key}), plan revision ${check.request.property.planRevision}`] : []),
    `Task: ${check.request.task.replace(/\s+/g, ' ')}`,
    `Start: ${check.request.startUrl}`,
    `Site: ${check.request.siteHosts.join(', ')}`,
    `${s.results} of ${s.expected} runs finished · ${s.passed} passed · ${s.failed} failed · ${s.errored} errored${s.unverifiedPasses ? ` · ${s.unverifiedPasses} pass${s.unverifiedPasses === 1 ? '' : 'es'} unverified (no expectation set)` : ''}`,
  ]
  if (check.error) lines.push(`Error: ${check.error}`)
  if (check.results.length) {
    lines.push('')
    const header = `  ${pad('agent', 13)}${pad('sees', 20)}${pad('run', 5)}${pad('status', 21)}${pad('time', 8)}${pad('actions', 9)}detail`
    lines.push(header)
    for (const r of check.results) {
      lines.push(`  ${pad(r.agent, 13)}${pad(sees(r), 20)}${pad(String(r.attempt), 5)}${pad(statusLabel(r), 21)}${pad(seconds(r.durationMs), 8)}${pad(String(r.actions), 9)}${r.detail}`)
    }
    const evidence = check.results.find((r) => r.evidencePath)?.evidencePath
    if (evidence) lines.push('', `Screenshots and action logs: ${evidence.replace(/[/\\][^/\\]+$/, '')}`)
  }
  return lines.join('\n')
}

export interface AgentBrowserCheckOptions {
  request: AgentBrowserCheckRequest
  wait?: boolean
  format?: string
}

/**
 * A waited check that ended `failed` (no agent run could be judged, or the check itself broke)
 * exits 2, like `canonry run --wait`: worth retrying once the cause is fixed. A completed or
 * partial check exits 0 whatever its agents found, because a failed agent run is a finding
 * about the site, not a failure of the check.
 */
function throwIfWaitedCheckFailed(project: string, check: AgentBrowserCheckDto): void {
  if (check.status !== RunStatuses.failed) return
  throw new CliError({
    code: 'RUN_FAILED',
    message: `Agent-browser check ${check.runId} failed${check.error ? `: ${check.error}` : ''}`,
    exitCode: EXIT_SYSTEM_ERROR,
    details: { project, runId: check.runId, error: check.error },
  })
}

/** `canonry agent-browser check <project>` — start a check (it spends on provider accounts). */
export async function agentBrowserCheck(project: string, opts: AgentBrowserCheckOptions): Promise<void> {
  const client = getClient()
  const started = await client.triggerAgentBrowserCheck(project, opts.request)
  if (!opts.wait) {
    if (isMachineFormat(opts.format)) {
      console.log(JSON.stringify(started, null, 2))
      return
    }
    const joined = started.reused ? ' (an identical check was already running; joined it)' : ''
    console.log(`Agent-browser check started: run ${started.runId}, status ${started.status}${joined}.`)
    console.log(`Follow it with \`canonry agent-browser show ${project} --run-id ${started.runId}\`, or pass --wait.`)
    return
  }
  const perRunMinutes = opts.request.maxMinutesPerRun ?? 8
  const timeoutMs = Math.min(90, perRunMinutes * Math.max(1, opts.request.repeats ?? 1) * 2 + 5) * 60_000
  const start = Date.now()
  if (!isMachineFormat(opts.format)) process.stderr.write('Running')
  let check = await client.getAgentBrowserCheck(project, started.runId)
  while (!TERMINAL.has(check.status) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    check = await client.getAgentBrowserCheck(project, started.runId)
    if (!isMachineFormat(opts.format)) process.stderr.write('.')
  }
  if (!isMachineFormat(opts.format)) process.stderr.write('\n')
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(check, null, 2))
  } else {
    if (!TERMINAL.has(check.status)) console.log(`Still ${check.status} after waiting; showing what has finished so far.`)
    console.log(renderAgentBrowserCheck(check))
  }
  throwIfWaitedCheckFailed(project, check)
}

/** `canonry agent-browser checks <project>` — the project's checks, newest first. */
export async function agentBrowserChecks(project: string, opts: { limit?: number; property?: string; format?: string }): Promise<void> {
  const result = await getClient().listAgentBrowserChecks(project, { limit: opts.limit, property: opts.property })
  if (opts.format === 'jsonl') {
    emitJsonl(result.checks.map((check) => ({ project: result.project, ...check })))
    return
  }
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (!result.checks.length) {
    const scope = opts.property ? ` of Property "${opts.property}"` : ''
    const flag = opts.property ? ` --property ${opts.property}` : ''
    console.log(`No agent-browser checks${scope} for ${project} yet. Start one with \`canonry agent-browser check ${project}${flag} --task "<what to do>"\`.`)
    return
  }
  for (const c of result.checks) {
    const s = c.summary
    const where = c.property ? `${c.property.label}  ` : ''
    console.log(`${c.createdAt}  ${c.runId}  ${pad(c.status, 10)} ${s.passed}/${s.expected} passed, ${s.failed} failed, ${s.errored} errored  ${c.agents.join(',')}  ${where}${c.task.replace(/\s+/g, ' ').slice(0, 80)}`)
  }
}

/** `canonry agent-browser show <project> --run-id <id>` — one check with every agent run. */
export async function agentBrowserShow(project: string, runId: string, opts: { format?: string }): Promise<void> {
  const check = await getClient().getAgentBrowserCheck(project, runId)
  if (opts.format === 'jsonl') {
    emitJsonl(check.results.map((result) => ({ project: check.project, runId: check.runId, ...result })))
    return
  }
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(check, null, 2))
    return
  }
  console.log(renderAgentBrowserCheck(check))
}
