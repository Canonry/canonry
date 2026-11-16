// Whether a run did what the task asked. The harness decides this from what it saw (the page
// the run ended on, the answer, the form submission it caught), never from the agent's own
// claim of success. Pages can contain text that tells an agent it succeeded.

import type { AgentBrowserResultStatus } from '@canonry/canonry-contracts'
import { AgentBrowserResultStatuses, jsonValueText } from '@canonry/canonry-contracts'
import type { CapturedWrite } from './browser.js'

export interface CheckExpectation {
  /** The run must end on this path (trailing slash ignored). */
  urlPath?: string
  /** Each phrase must appear in the final answer, ignoring case. */
  answerIncludes?: string[]
  /** A submission to this path must have been caught. */
  submitPath?: string
  /** The caught submission must carry these values, compared ignoring case and surrounding space. */
  submitFields?: Record<string, string>
}

export interface CheckOutcome {
  /** True when every expectation held; null when the check had no expectation to verify. */
  passed: boolean | null
  details: Array<{ check: string; passed: boolean; detail: string }>
  /** The agent's own verdict from its "ANSWER:" line. */
  agentClaimedFailure: boolean
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/'
  } catch {
    return ''
  }
}

function normalizePath(p: string): string {
  const withSlash = p.startsWith('/') ? p : `/${p}`
  return withSlash.replace(/\/+$/, '') || '/'
}

/** Reads a caught request body as fields: JSON objects and URL-encoded forms. */
export function parseSubmittedFields(body: string | null): Record<string, string> | null {
  if (!body) return null
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, jsonValueText(v)]))
      }
    } catch {
      return null
    }
    return null
  }
  if (/^[^=&\s]+=/.test(trimmed)) return Object.fromEntries(new URLSearchParams(trimmed))
  return null
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function evaluateExpectation(
  observed: { finalUrl: string; answer: string; writes: CapturedWrite[] },
  expect: CheckExpectation,
): CheckOutcome {
  const details: CheckOutcome['details'] = []
  const agentClaimedFailure = /ANSWER:\s*FAILED/i.test(observed.answer)
  if (expect.urlPath !== undefined) {
    const want = normalizePath(expect.urlPath)
    const got = pathOf(observed.finalUrl)
    details.push({ check: 'urlPath', passed: got === want, detail: got === want ? `ended on ${want}` : `ended on ${got || 'no page'}, not ${want}` })
  }
  for (const phrase of expect.answerIncludes ?? []) {
    const ok = observed.answer.toLowerCase().includes(phrase.toLowerCase())
    details.push({ check: 'answerIncludes', passed: ok, detail: ok ? `answer mentions "${phrase}"` : `answer does not mention "${phrase}"` })
  }
  if (expect.submitPath !== undefined) {
    const want = normalizePath(expect.submitPath)
    const submits = observed.writes.filter((w) => pathOf(w.url) === want)
    if (!submits.length) {
      details.push({ check: 'submitPath', passed: false, detail: `nothing was submitted to ${want}` })
    } else {
      details.push({ check: 'submitPath', passed: true, detail: `${submits.length} submission${submits.length === 1 ? '' : 's'} to ${want}` })
      const fields = parseSubmittedFields(submits.at(-1)?.body ?? null)
      for (const [key, want] of Object.entries(expect.submitFields ?? {})) {
        const got = fields?.[key]
        const ok = got !== undefined && same(got, want)
        details.push({ check: `submitFields.${key}`, passed: ok, detail: ok ? `${key} = ${want}` : `${key} was ${got === undefined ? 'missing' : `"${got}"`}, expected "${want}"` })
      }
    }
  }
  if (!details.length) return { passed: null, details, agentClaimedFailure }
  return { passed: details.every((d) => d.passed), details, agentClaimedFailure }
}

export interface AgentRunVerdict {
  status: AgentBrowserResultStatus
  /** True when the status was checked against expectations; false when it rests on the agent's claim. */
  verified: boolean
  detail: string
  checks: Array<{ check: string; passed: boolean; detail: string }>
}

/**
 * How one agent run ended. A run that threw (the provider or the browser failed) is
 * `errored`, which says nothing about the site. With expectations, Canonry's own checks decide
 * pass or fail. Without any, the run's own outcome is all there is and the result says so: a
 * run that stopped early or reported "ANSWER: FAILED" failed, anything else is an unverified pass.
 */
export function judgeAgentRun(
  out: { answer: string; stop: string } | null,
  error: string | null,
  observed: { finalUrl: string; writes: CapturedWrite[] },
  expect: CheckExpectation,
): AgentRunVerdict {
  if (!out) return { status: AgentBrowserResultStatuses.errored, verified: false, detail: error ?? 'the run did not finish', checks: [] }
  const outcome = evaluateExpectation({ finalUrl: observed.finalUrl, answer: out.answer, writes: observed.writes }, expect)
  const stoppedEarly = out.stop !== 'final'
  if (outcome.passed === null) {
    if (stoppedEarly) return { status: AgentBrowserResultStatuses.failed, verified: false, detail: `stopped: ${out.stop}`, checks: [] }
    if (outcome.agentClaimedFailure) return { status: AgentBrowserResultStatuses.failed, verified: false, detail: 'the agent reported it could not finish', checks: [] }
    return { status: AgentBrowserResultStatuses.passed, verified: false, detail: 'the agent reported success; no expectation was set to check it', checks: [] }
  }
  if (outcome.passed) return { status: AgentBrowserResultStatuses.passed, verified: true, detail: outcome.details.map((d) => d.detail).join('; '), checks: outcome.details }
  const failing = outcome.details.filter((d) => !d.passed).map((d) => d.detail)
  const reason = stoppedEarly ? `stopped: ${out.stop}; ` : ''
  return { status: AgentBrowserResultStatuses.failed, verified: true, detail: `${reason}${failing.join('; ')}`, checks: outcome.details }
}
