import { z } from 'zod'
import { runStatusSchema, runTriggerSchema } from './run.js'
import { hostOf } from './url-normalize.js'

/**
 * Agent-browser checks: AI agents try a task on a project's site in a real browser.
 *
 * Each agent is a model plus the way it sees the page. Three work from screenshots
 * through their provider's computer-use API; `claude-a11y` is the same Claude model
 * reading Chrome's accessibility tree instead of pixels.
 */
export const agentBrowserAgentSchema = z.enum(['openai', 'claude', 'gemini', 'claude-a11y'])
export type AgentBrowserAgent = z.infer<typeof agentBrowserAgentSchema>
export const AgentBrowserAgents = agentBrowserAgentSchema.enum

export const agentBrowserPerceptionSchema = z.enum(['screenshots', 'accessibility-tree'])
export type AgentBrowserPerception = z.infer<typeof agentBrowserPerceptionSchema>
export const AgentBrowserPerceptions = agentBrowserPerceptionSchema.enum

/** Which provider credential and default model each agent uses, and how it sees the page. */
export const AGENT_BROWSER_AGENT_PROFILES: Record<AgentBrowserAgent, { provider: 'openai' | 'claude' | 'gemini'; defaultModel: string; perception: AgentBrowserPerception }> = {
  openai: { provider: 'openai', defaultModel: 'gpt-6.1-sol', perception: AgentBrowserPerceptions.screenshots },
  claude: { provider: 'claude', defaultModel: 'claude-opus-5-5', perception: AgentBrowserPerceptions.screenshots },
  gemini: { provider: 'gemini', defaultModel: 'gemini-4-carbon', perception: AgentBrowserPerceptions.screenshots },
  'claude-a11y': { provider: 'claude', defaultModel: 'claude-opus-5-5', perception: AgentBrowserPerceptions['accessibility-tree'] },
}

/** The agents a check uses when the request names none: fast enough for a few-minute check. */
export const DEFAULT_AGENT_BROWSER_AGENTS: readonly AgentBrowserAgent[] = [AgentBrowserAgents.openai, AgentBrowserAgents.claude, AgentBrowserAgents['claude-a11y']]

/**
 * How one agent run ended.
 *
 * - `passed`  every expectation held, checked by Canonry, not by the agent.
 * - `failed`  an expectation did not hold, the agent gave up, or it ran out of time or turns.
 * - `errored` the run could not be judged: the provider or the browser failed. It says nothing
 *             about the site or the agent and never counts against either.
 */
export const agentBrowserResultStatusSchema = z.enum(['passed', 'failed', 'errored'])
export type AgentBrowserResultStatus = z.infer<typeof agentBrowserResultStatusSchema>
export const AgentBrowserResultStatuses = agentBrowserResultStatusSchema.enum

/** Limits on one check. A check spends on the operator's provider accounts, so every run is bounded. */
export const AGENT_BROWSER_LIMITS = {
  maxTaskLength: 4000,
  maxRepeats: 5,
  defaultRepeats: 1,
  defaultMaxMinutesPerRun: 8,
  maxMinutesPerRun: 20,
  defaultMaxTurnsPerRun: 60,
  maxTurnsPerRun: 150,
} as const

/**
 * What Canonry checks after a run, from what it saw itself: the page the run ended on, the
 * answer, and the form submission the browser caught. A run with no expectation rests on the
 * agent's own claim and is reported as unverified.
 */
export const agentBrowserExpectationSchema = z
  .object({
    /** The run must end on this path of the site (trailing slash ignored). */
    urlPath: z.string().min(1).max(2048).optional(),
    /** Each phrase must appear in the agent's final answer, ignoring case. */
    answerIncludes: z.array(z.string().min(1).max(200)).max(10).optional(),
    /** A form submission to this path must have been caught. */
    submitPath: z.string().min(1).max(2048).optional(),
    /** The caught submission must carry these field values (JSON or URL-encoded), ignoring case. */
    submitFields: z.record(z.string().min(1).max(100), z.string().max(500)).optional(),
  })
  .strict()
  .refine((value) => value.submitFields === undefined || value.submitPath !== undefined, {
    message: '"submitFields" needs "submitPath": name the path the form submits to',
    path: ['submitFields'],
  })
export type AgentBrowserExpectation = z.infer<typeof agentBrowserExpectationSchema>

/** A model per agent, overriding its default. */
export const agentBrowserModelsSchema = z
  .object({
    openai: z.string().min(1).max(200).optional(),
    claude: z.string().min(1).max(200).optional(),
    gemini: z.string().min(1).max(200).optional(),
    'claude-a11y': z.string().min(1).max(200).optional(),
  })
  .strict()

/** Body for `POST /projects/:name/agent-browser/checks`. */
export const agentBrowserCheckRequestSchema = z.object({
  /** What the agents should do on the site, in plain words. */
  task: z.string().trim().min(1).max(AGENT_BROWSER_LIMITS.maxTaskLength),
  /**
   * An Advanced Measurement Property to check, by its stable key in the published plan. Its URLs
   * count as the site, and the agents start on its most specific page unless `startUrl` is given.
   */
  property: z.string().trim().min(1).max(128).optional(),
  /** Where every agent starts. It must be on the site; default: the Property's page, else the project's home page. */
  startUrl: z.string().url().optional(),
  /** Which agents try the task; default: OpenAI and Claude on screenshots, and Claude on the accessibility tree. */
  agents: z.array(agentBrowserAgentSchema).min(1).max(agentBrowserAgentSchema.options.length).optional(),
  models: agentBrowserModelsSchema.optional(),
  /** Runs per agent; agents vary from run to run, so more than one shows how reliable a result is. */
  repeats: z.number().int().min(1).max(AGENT_BROWSER_LIMITS.maxRepeats).optional(),
  expect: agentBrowserExpectationSchema.optional(),
  maxMinutesPerRun: z.number().int().min(1).max(AGENT_BROWSER_LIMITS.maxMinutesPerRun).optional(),
  maxTurnsPerRun: z.number().int().min(5).max(AGENT_BROWSER_LIMITS.maxTurnsPerRun).optional(),
})
export type AgentBrowserCheckRequest = z.infer<typeof agentBrowserCheckRequestSchema>

/**
 * The request a check runs with, after defaults. Every field changes what the check produces,
 * so the whole object is the check's identity: an identical request reuses an active check, a
 * different one is refused while a check is active.
 */
export const agentBrowserPropertyScopeSchema = z.object({
  /** The Property's stable key in the measurement plan. */
  key: z.string(),
  label: z.string(),
  /** The published plan revision the Property's URLs were read from. */
  planRevision: z.number().int(),
})
export type AgentBrowserPropertyScope = z.infer<typeof agentBrowserPropertyScopeSchema>

export const agentBrowserEffectiveRequestSchema = z.object({
  schemaVersion: z.literal(1),
  task: z.string(),
  /** The Advanced Measurement Property checked; null when the check covers the project's site. */
  property: agentBrowserPropertyScopeSchema.nullable(),
  /** Hosts that count as the site, frozen when the check was asked for: writes to them are answered locally, other sites are blocked. */
  siteHosts: z.array(z.string()),
  startUrl: z.string(),
  agents: z.array(z.object({ agent: agentBrowserAgentSchema, model: z.string(), perception: agentBrowserPerceptionSchema })),
  repeats: z.number().int(),
  expect: z.object({
    urlPath: z.string().nullable(),
    answerIncludes: z.array(z.string()),
    submitPath: z.string().nullable(),
    submitFields: z.record(z.string(), z.string()),
  }),
  maxMinutesPerRun: z.number().int(),
  maxTurnsPerRun: z.number().int(),
})
export type AgentBrowserEffectiveRequest = z.infer<typeof agentBrowserEffectiveRequestSchema>

const normalizeUrlPath = (value: string): string => {
  const withSlash = value.startsWith('/') ? value : `/${value}`
  return withSlash.replace(/\/+$/, '') || '/'
}

/** What a check covers, resolved by the server from the project or one of its Properties. */
export interface AgentBrowserCheckScope {
  property: AgentBrowserPropertyScope | null
  siteHosts: readonly string[]
  /** The page agents start on when the request names none. */
  defaultStartUrl: string
}

/** Applies defaults and puts the request in one canonical shape, within the scope the server resolved. */
export function normalizeAgentBrowserCheckRequest(request: AgentBrowserCheckRequest, scope: AgentBrowserCheckScope): AgentBrowserEffectiveRequest {
  const chosen = request.agents?.length ? [...new Set(request.agents)] : [...DEFAULT_AGENT_BROWSER_AGENTS]
  const order = agentBrowserAgentSchema.options
  chosen.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return {
    schemaVersion: 1,
    task: request.task.trim(),
    property: scope.property,
    siteHosts: [...new Set(scope.siteHosts)].sort(),
    startUrl: new URL(request.startUrl ?? scope.defaultStartUrl).toString(),
    agents: chosen.map((agent) => ({
      agent,
      model: request.models?.[agent] ?? AGENT_BROWSER_AGENT_PROFILES[agent].defaultModel,
      perception: AGENT_BROWSER_AGENT_PROFILES[agent].perception,
    })),
    repeats: request.repeats ?? AGENT_BROWSER_LIMITS.defaultRepeats,
    expect: {
      urlPath: request.expect?.urlPath !== undefined ? normalizeUrlPath(request.expect.urlPath) : null,
      answerIncludes: [...(request.expect?.answerIncludes ?? [])],
      submitPath: request.expect?.submitPath !== undefined ? normalizeUrlPath(request.expect.submitPath) : null,
      submitFields: Object.fromEntries(Object.entries(request.expect?.submitFields ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    },
    maxMinutesPerRun: request.maxMinutesPerRun ?? AGENT_BROWSER_LIMITS.defaultMaxMinutesPerRun,
    maxTurnsPerRun: request.maxTurnsPerRun ?? AGENT_BROWSER_LIMITS.defaultMaxTurnsPerRun,
  }
}

/** Stable identity key for comparing a request with an active check. */
export function agentBrowserRequestIdentity(request: AgentBrowserEffectiveRequest): string {
  return JSON.stringify([
    request.schemaVersion,
    request.task,
    request.property?.key ?? null,
    request.siteHosts,
    request.startUrl,
    request.agents.map((a) => [a.agent, a.model]),
    request.repeats,
    request.expect.urlPath,
    request.expect.answerIncludes,
    request.expect.submitPath,
    Object.entries(request.expect.submitFields),
    request.maxMinutesPerRun,
    request.maxTurnsPerRun,
  ])
}

export const agentBrowserCheckRunResponseSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  /** True when an identical check was already active and this request joined it. */
  reused: z.boolean(),
})
export type AgentBrowserCheckRunResponseDto = z.infer<typeof agentBrowserCheckRunResponseSchema>

export const agentBrowserUsageSchema = z.object({
  requests: z.number().int().nonnegative(),
  /** Every input token billed, cached ones included. */
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  /** Output tokens, thinking included. */
  outputTokens: z.number().int().nonnegative(),
})
export type AgentBrowserUsage = z.infer<typeof agentBrowserUsageSchema>

export const agentBrowserSubmissionSchema = z.object({
  url: z.string(),
  method: z.string(),
  body: z.string().nullable(),
  /** True for a submission to the site, answered by the browser; false for one to another site, dropped. */
  answeredLocally: z.boolean(),
})
export type AgentBrowserSubmission = z.infer<typeof agentBrowserSubmissionSchema>

export const agentBrowserResultSchema = z.object({
  id: z.string(),
  agent: agentBrowserAgentSchema,
  model: z.string(),
  perception: agentBrowserPerceptionSchema,
  attempt: z.number().int().positive(),
  status: agentBrowserResultStatusSchema,
  /** True when Canonry checked the outcome against expectations; false when it rests on the agent's claim. */
  verified: z.boolean(),
  detail: z.string(),
  checks: z.array(z.object({ check: z.string(), passed: z.boolean(), detail: z.string() })),
  answer: z.string(),
  /** Why the agent stopped: `final`, `turn-limit`, `time-limit`, `refusal`, `cancelled`, `error`, or the provider's reason. */
  stop: z.string(),
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  screenshots: z.number().int().nonnegative(),
  safetyChecks: z.number().int().nonnegative(),
  usage: agentBrowserUsageSchema,
  finalUrl: z.string(),
  visited: z.array(z.string()),
  blockedPages: z.array(z.string()),
  submissions: z.array(agentBrowserSubmissionSchema),
  /** Where this run's screenshots and action log are kept on the Canonry host; null when none were kept. */
  evidencePath: z.string().nullable(),
  createdAt: z.string(),
})
export type AgentBrowserResultDto = z.infer<typeof agentBrowserResultSchema>

export const agentBrowserSummarySchema = z.object({
  /** Runs the check asked for: agents × repeats. */
  expected: z.number().int().nonnegative(),
  /** Runs that finished, whatever their status. */
  results: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  /** Passed runs that rest on the agent's claim, not on an expectation. */
  unverifiedPasses: z.number().int().nonnegative(),
})
export type AgentBrowserSummaryDto = z.infer<typeof agentBrowserSummarySchema>

/** Counts a check's results; `results` is always passed + failed + errored. */
export function summarizeAgentBrowserResults(
  results: ReadonlyArray<{ status: AgentBrowserResultStatus; verified: boolean }>,
  expected: number,
): AgentBrowserSummaryDto {
  const count = (status: AgentBrowserResultStatus) => results.filter((r) => r.status === status).length
  return {
    expected,
    results: results.length,
    passed: count(AgentBrowserResultStatuses.passed),
    failed: count(AgentBrowserResultStatuses.failed),
    errored: count(AgentBrowserResultStatuses.errored),
    unverifiedPasses: results.filter((r) => r.status === AgentBrowserResultStatuses.passed && !r.verified).length,
  }
}

export const agentBrowserCheckDtoSchema = z.object({
  runId: z.string(),
  project: z.string(),
  status: runStatusSchema,
  trigger: runTriggerSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  request: agentBrowserEffectiveRequestSchema,
  summary: agentBrowserSummarySchema,
  results: z.array(agentBrowserResultSchema),
})
export type AgentBrowserCheckDto = z.infer<typeof agentBrowserCheckDtoSchema>

export const agentBrowserCheckListItemSchema = z.object({
  runId: z.string(),
  /** The Property checked; null for a check of the project's site. */
  property: agentBrowserPropertyScopeSchema.pick({ key: true, label: true }).nullable(),
  status: runStatusSchema,
  trigger: runTriggerSchema,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  task: z.string(),
  startUrl: z.string(),
  agents: z.array(agentBrowserAgentSchema),
  summary: agentBrowserSummarySchema,
})
export type AgentBrowserCheckListItemDto = z.infer<typeof agentBrowserCheckListItemSchema>

export const agentBrowserChecksResponseSchema = z.object({
  project: z.string(),
  checks: z.array(agentBrowserCheckListItemSchema),
})
export type AgentBrowserChecksResponseDto = z.infer<typeof agentBrowserChecksResponseSchema>

/** Bare hosts of a project's site, without "www.": its canonical domain and its owned domains. */
export function agentBrowserSiteHosts(canonicalDomain: string, ownedDomains: readonly string[]): string[] {
  return [...new Set([canonicalDomain, ...ownedDomains].map((domain) => hostOf(domain)).filter((host): host is string => Boolean(host)))]
}

/** One URL rule of a measurement plan Target, in the shape both plan versions store. */
export type AgentBrowserTargetUrlRule =
  | { kind: 'exact'; url: string }
  | { kind: 'prefix'; host: string; pathPrefix: string }
  | { kind: 'host'; host: string }

const absoluteUrl = (value: string): string | null => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Where a Property lives, from its published URL rules: the bare hosts its rules name, and the
 * page a check starts on, by the plan's own precedence: an exact page first, then the longest
 * path prefix, then the host's home page. The start page is null when no rule names a page.
 */
export function agentBrowserPropertySite(rules: readonly AgentBrowserTargetUrlRule[]): { hosts: string[]; startUrl: string | null } {
  const hosts = new Set<string>()
  for (const rule of rules) {
    const host = hostOf(rule.kind === 'exact' ? rule.url : rule.host)
    if (host) hosts.add(host)
  }
  const exact = rules.flatMap((rule) => (rule.kind === 'exact' ? [absoluteUrl(rule.url)] : [])).find((url): url is string => url !== null)
  const prefix = rules
    .flatMap((rule) => (rule.kind === 'prefix' ? [rule] : []))
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)
    .map((rule) => absoluteUrl(`https://${rule.host}${rule.pathPrefix.startsWith('/') ? '' : '/'}${rule.pathPrefix}`))
    .find((url): url is string => url !== null)
  const home = rules
    .flatMap((rule) => (rule.kind === 'host' ? [absoluteUrl(`https://${rule.host}/`)] : []))
    .find((url): url is string => url !== null)
  return { hosts: [...hosts].sort(), startUrl: exact ?? prefix ?? home ?? null }
}

/**
 * True when a host belongs to the site under test: one of its hosts or a subdomain of one.
 * A check lets the browser write to these hosts (answered locally) and blocks every other site.
 */
export function isAgentBrowserSiteHost(host: string, siteHosts: readonly string[]): boolean {
  const bare = host.trim().toLowerCase().replace(/^www\./, '')
  return siteHosts.some((domain) => bare === domain || bare.endsWith(`.${domain}`))
}
