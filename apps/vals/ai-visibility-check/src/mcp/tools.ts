/**
 * The MCP tool surface: reads over checks this val has already run, plus the
 * bundled skills for clients that do not implement MCP resources.
 *
 * Every tool but `start_check` is a read, and `start_check` runs the host's
 * full admission path — same global daily cap, same single execution lease,
 * same cache reuse — differing only in that it skips Turnstile, which an agent
 * cannot solve, and spends from its own tighter per-caller bucket. The global
 * cap is what bounds the bill; Turnstile bounds fairness, so this widens who
 * may spend the budget without widening the budget.
 *
 * Results are JSON in a text block rather than `structuredContent`, because
 * every client across both protocol eras renders text content, while typed
 * output is newer and unevenly implemented.
 */
import { type CheckRecord, checkFingerprint, type CheckStore, isCheckExpired } from 'npm:@canonry/val-kit@0.2.0/jobs'
import { listSkillResources, readSkillResource, skillIndex } from 'npm:@canonry/val-kit@0.2.0/mcp'
import { normalizePublicDomain, PublicUrlError } from 'npm:@canonry/val-kit@0.2.0/security'
import {
  computeMentionShare,
  computeShareOfVoice,
  type ShareOfVoice,
  type VisibilityEvidence,
} from 'npm:@canonry/val-kit@0.2.0/visibility'
import { CHECK_FINGERPRINT_NAMESPACE, type CheckResult } from '../runtime/check-result.ts'
import { orderFactors } from '../site-health/factor-order.ts'

const CHECK_ID = /^[0-9a-f-]{36}$/i

export interface McpToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** Runs the host's full admission path; absent when the host disables MCP starts. */
export type StartCheckFn = (
  domain: string,
  remoteIp: string | null,
  queries: readonly string[],
) => Promise<{ record: CheckRecord<CheckResult>; reused: boolean }>

export interface McpToolContext {
  store: CheckStore<CheckResult>
  now: () => Date
  startCheck?: StartCheckFn
  /** Edge-provided caller identity, used only as the quota subject. */
  remoteIp?: string | null
}

function ok(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function fail(message: string, hint?: string): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(hint ? { error: message, hint } : { error: message }, null, 2) }],
    isError: true,
  }
}

const TARGET_SCHEMA = {
  type: 'object',
  properties: {
    checkId: { type: 'string', description: 'A check ID returned by a previous tool call or shown in the web UI.' },
    domain: {
      type: 'string',
      description:
        'A domain such as "example.com". Resolves the most recent cached check; it never starts one. Use start_check ' +
        'to run a fresh check.',
    },
  },
  additionalProperties: false,
} as const

/**
 * Resolve either addressing mode to a readable record.
 *
 * A domain lookup only ever finds work the val already did — it never starts
 * a check — so a miss is reported as a miss rather than quietly queuing paid
 * work the caller did not ask for.
 */
async function resolveCheck(
  context: McpToolContext,
  args: Record<string, unknown>,
): Promise<{ record: CheckRecord<CheckResult> } | { error: McpToolResult }> {
  const checkId = typeof args.checkId === 'string' ? args.checkId.trim() : ''
  const domain = typeof args.domain === 'string' ? args.domain.trim() : ''

  if (!checkId && !domain) return { error: fail('Provide either "checkId" or "domain".') }

  const now = context.now()

  if (checkId) {
    if (!CHECK_ID.test(checkId)) return { error: fail(`"${checkId}" is not a valid check ID.`) }
    const record = await context.store.get(checkId)
    if (!record || isCheckExpired(record, now)) {
      return {
        error: fail(`No check found for ID "${checkId}".`, 'Public checks expire; run a new one from the web UI.'),
      }
    }
    return { record }
  }

  let normalized: string
  try {
    normalized = normalizePublicDomain(domain).domain
  } catch (error) {
    return { error: fail(error instanceof PublicUrlError ? error.message : 'Enter a valid public domain.') }
  }

  const record = await context.store.findReusable(
    checkFingerprint(CHECK_FINGERPRINT_NAMESPACE, normalized),
    now.toISOString(),
  )
  if (!record) {
    return {
      error: fail(
        `No cached check for "${normalized}".`,
        'Run one with start_check, or from the web UI, then read it here.',
      ),
    }
  }
  return { record }
}

/** Shared envelope so every tool reports status and freshness the same way. */
function recordEnvelope(record: CheckRecord<CheckResult>) {
  return {
    checkId: record.id,
    domain: record.domain,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    error: record.errorCode ? { code: record.errorCode, message: record.errorMessage } : null,
  }
}

/**
 * Mention and citation are independent signals and are always reported as a
 * pair. A rate is null when nothing succeeded, never 0 — a provider failure is
 * an absent measurement, not a miss, and collapsing the two would report a site
 * as invisible when the check simply did not complete.
 */
function visibilitySummary(record: CheckRecord<CheckResult>) {
  const visibility = record.result?.visibility
  if (!visibility) return { measured: false as const }
  // Only a fully generated basket is guaranteed non-brand. Caller-supplied
  // queries may be branded, so labeling a mixed basket "non-brand" would break
  // the "class travels with the number" rule.
  const hasSuppliedQueries = record.userQueries.length > 0
  return {
    measured: true as const,
    scope: hasSuppliedQueries ? 'mixed' : 'non-brand',
    scopeNote: hasSuppliedQueries
      ? 'Includes caller-supplied queries, which may be branded, so rates are not restricted to non-brand queries.'
      : 'Queries are generated non-brand queries, so the project cannot be handed its own answer.',
    successfulChecks: visibility.summary.successfulChecks,
    failedChecks: visibility.summary.failedChecks,
    mentionRate: visibility.summary.mentionRate,
    citationRate: visibility.summary.citationRate,
    rateNote: 'Rates are over successful checks only. A null rate means nothing succeeded, not a rate of zero.',
    startedAt: visibility.startedAt,
    completedAt: visibility.completedAt,
  }
}

function siteHealthSummary(record: CheckRecord<CheckResult>) {
  const siteHealth = record.result?.siteHealth
  if (!siteHealth) return { measured: false as const }
  return {
    measured: true as const,
    label: siteHealth.label,
    status: siteHealth.status,
    score: siteHealth.score,
    pagesDiscovered: siteHealth.pagesDiscovered,
    pagesFetched: siteHealth.pagesFetched,
    pagesObserved: siteHealth.pagesObserved,
    terminationReason: siteHealth.terminationReason,
    warnings: siteHealth.warnings,
    error: siteHealth.error,
  }
}

/** One share table on the wire, or null when that signal was not measurable. */
function shareTable(share: ShareOfVoice | null, note: string) {
  if (!share) return null
  return {
    basis: share.basis,
    note,
    measuredAnswers: share.measuredAnswers,
    unattributedAnswers: share.unattributedAnswers,
    totalAppearances: share.totalAppearances,
    targetShare: share.targetShare,
    entries: share.entries,
  }
}

/**
 * The mention table is keyed by name, so the target's row needs the brand the
 * answers wrote, not its domain. Falls back to the domain when no answer named
 * it, which is the case where the row exists to report a zero.
 */
function targetBrandLabel(evidence: readonly VisibilityEvidence[], domain: string): string {
  for (const row of evidence) {
    const name = row.matchedTerms.find((term) => !term.includes('.'))
    if (name) return name
  }
  return domain
}

function evidenceRow(evidence: VisibilityEvidence) {
  return {
    query: evidence.query,
    provider: evidence.provider,
    servedModel: evidence.servedModel,
    completedAt: evidence.completedAt,
    // Both signals, always. `null` on either means that check failed.
    mentioned: evidence.mentioned,
    matchedTerms: evidence.matchedTerms,
    cited: evidence.cited,
    matchedCitationDomains: evidence.matchedCitationDomains,
    matchedCitationUrls: evidence.matchedCitationUrls,
    citedDomains: evidence.citedDomains,
    sources: evidence.sources,
    searchQueries: evidence.searchQueries,
    // Brands this answer named, each verified to be written in it. Null means
    // the extraction did not run, not that the answer named nobody.
    namedBrands: evidence.namedBrands,
    retrievalStatus: evidence.retrievalStatus,
    answerText: evidence.answerText,
    error: evidence.error,
  }
}

/**
 * The conversion path. An agent that has just shown a user their coverage is
 * exactly where "how do I get this properly" gets asked, and without this it
 * would have to guess at an install command.
 */
const SELF_HOST_TOOL: McpToolDefinition = {
  name: 'self_host',
  title: 'How to self-host Canonry',
  description:
    'How to run the full Canonry platform instead of this bounded sample: install command, repository, docs, and ' +
    'what self-hosting adds over this endpoint. Call it when the user asks for more engines, scheduled tracking, ' +
    'more queries, their own data, or how any of this actually works.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

const START_CHECK_TOOL: McpToolDefinition = {
  name: 'start_check',
  title: 'Run a new Canonry check',
  description:
    'Run a fresh check for a domain: three grounded Gemini queries plus a bounded Technical AEO page sample. ' +
    'Blocks until the check finishes, up to about 45 seconds, and returns the same shape as get_check. A domain ' +
    'checked in the last 24 hours with the same questions returns the cached result immediately and costs nothing. ' +
    'Daily limits apply.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'A domain such as "example.com".' },
      queries: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 3,
        description:
          'Optional. Up to 3 questions to put to the answer engine, used verbatim. Any remaining slots are filled ' +
          'with questions generated for the site, so supplying none generates all three.',
      },
    },
    required: ['domain'],
    additionalProperties: false,
  },
}

const READ_TOOLS: readonly McpToolDefinition[] = [
  SELF_HOST_TOOL,
  {
    name: 'get_check',
    title: 'Get a Canonry check',
    description:
      'Status and headline numbers for one domain check: AI visibility (mention and citation rates over non-brand ' +
      'queries) and the bounded Technical AEO site sample. Address it by checkId or by domain. Reads existing work ' +
      'only — it never starts a new check.',
    inputSchema: TARGET_SCHEMA,
  },
  {
    name: 'get_ai_visibility',
    title: 'Get AI visibility evidence',
    description:
      'Per query and answer engine evidence for one check. Every row carries "mentioned" (the brand appears in the ' +
      'answer text) and "cited" (the domain appears in the sources behind the answer) as independent signals, plus ' +
      'the answer text, the cited domains and URLs, and the search queries the engine issued. A null signal means ' +
      'that check failed and was not measured. Also returns two share tables, which are never mixed: citationShare ' +
      '(which domains the engine cited, and what share each holds) and mentionShare (which brands the answer prose ' +
      'named). Every name in mentionShare was verified to be written in the answer it is counted against.',
    inputSchema: TARGET_SCHEMA,
  },
  {
    name: 'get_site_health',
    title: 'Get Technical AEO site sample',
    description:
      'The bounded Technical AEO sample for one check: overall score, per-factor averages, and per-page scores with ' +
      'findings, critical defects, and recommendations, plus siteMap — the internal link graph observed by the same ' +
      'crawl, as nodes and edges. A node is either crawled (it has a score and an indexability verdict) or merely ' +
      'linked to (it has neither). This is a small page sample, not a whole-site audit.',
    inputSchema: TARGET_SCHEMA,
  },
  {
    name: 'list_skills',
    title: 'List Canonry skill documents',
    description:
      'Index of the bundled canonry (operator) and aero (analyst) skill documents available from this endpoint. ' +
      'Entry points come first; read one with read_skill. Clients that support MCP resources can read the same ' +
      'documents from resources/list.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_skill',
    title: 'Read a Canonry skill document',
    description: 'Read one skill document as markdown. Accepts a canonry-skill:// URI or a path such as ' +
      '"aero/references/regression-playbook.md". Start with an entry point from list_skills, then open the ' +
      'reference the task calls for.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'A canonry-skill:// URI, or "<skill>/<path>", or a bare reference path.' },
      },
      required: ['uri'],
      additionalProperties: false,
    },
  },
]

/** The advertised catalog. `start_check` appears only when the host can honour it. */
export function mcpTools(context: McpToolContext): readonly McpToolDefinition[] {
  return context.startCheck ? [...READ_TOOLS, START_CHECK_TOOL] : READ_TOOLS
}

export async function callMcpTool(
  context: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult | null> {
  switch (name) {
    case 'get_check': {
      const resolved = await resolveCheck(context, args)
      if ('error' in resolved) return resolved.error
      return ok({
        ...recordEnvelope(resolved.record),
        aiVisibility: visibilitySummary(resolved.record),
        siteHealth: siteHealthSummary(resolved.record),
        partialErrors: resolved.record.result?.errors ?? [],
      })
    }

    case 'get_ai_visibility': {
      const resolved = await resolveCheck(context, args)
      if ('error' in resolved) return resolved.error
      const visibility = resolved.record.result?.visibility
      if (!visibility) {
        return ok({
          ...recordEnvelope(resolved.record),
          measured: false,
          reason: resolved.record.status === 'queued' || resolved.record.status === 'running'
            ? 'The check is still running.'
            : 'This check has no AI visibility result.',
        })
      }
      const citationShare = computeShareOfVoice(visibility.evidence, visibility.domain)
      const mentionShare = computeMentionShare(
        visibility.evidence,
        targetBrandLabel(visibility.evidence, visibility.domain),
      )
      return ok({
        ...recordEnvelope(resolved.record),
        summary: visibilitySummary(resolved.record),
        // Two independent signals, two tables. Never one blended number: a site
        // can be cited without being named and named without being cited.
        citationShare: shareTable(
          citationShare,
          'Share of the sources the engine used, by how many answers each domain appeared in.',
        ),
        mentionShare: shareTable(
          mentionShare,
          'Share of the brands the answer prose named, by how many answers named each. Every name was verified to be ' +
            'written in the answer it is counted against; null means the extraction did not run.',
        ),
        // Retained under its historical name so an existing caller does not
        // break. It has always been the citation table.
        shareOfVoice: shareTable(
          citationShare,
          'Deprecated alias of citationShare. Use citationShare or mentionShare.',
        ),
        evidence: visibility.evidence.map(evidenceRow),
      })
    }

    case 'get_site_health': {
      const resolved = await resolveCheck(context, args)
      if ('error' in resolved) return resolved.error
      const siteHealth = resolved.record.result?.siteHealth
      if (!siteHealth) {
        return ok({
          ...recordEnvelope(resolved.record),
          measured: false,
          reason: resolved.record.status === 'queued' || resolved.record.status === 'running'
            ? 'The check is still running.'
            : 'This check has no Technical AEO result.',
        })
      }
      return ok({
        ...recordEnvelope(resolved.record),
        summary: siteHealthSummary(resolved.record),
        rootUrl: siteHealth.rootUrl,
        finalRootUrl: siteHealth.finalRootUrl,
        // Ranked best to worst, the same order the page shows. A factor with
        // no sampled page is unmeasured, so it ranks last rather than as a 0.
        factors: orderFactors(
          siteHealth.factors,
          (factor) => ({ score: factor.count > 0 ? factor.averageScore : null, label: factor.name }),
        ),
        pages: siteHealth.pages,
        // The internal-link graph from the same crawl. An agent asking "what
        // links to this weak page" needs the edges, not just the scores.
        siteMap: siteHealth.siteMap,
      })
    }

    case 'start_check': {
      if (!context.startCheck) return fail('Starting a check is not enabled on this endpoint.')
      const domain = typeof args.domain === 'string' ? args.domain.trim() : ''
      if (!domain) return fail('Provide a "domain".')
      try {
        const queries = Array.isArray(args.queries) ? args.queries : []
        const { record, reused } = await context.startCheck(domain, context.remoteIp ?? null, queries)
        return ok({
          ...recordEnvelope(record),
          reused,
          aiVisibility: visibilitySummary(record),
          siteHealth: siteHealthSummary(record),
          partialErrors: record.result?.errors ?? [],
        })
      } catch (error) {
        // The host throws typed admission failures (quota, capacity, invalid
        // domain). Their messages are already caller-safe and actionable.
        return fail(error instanceof Error ? error.message : 'The check could not be started.')
      }
    }

    case 'self_host':
      return ok({
        summary:
          'This endpoint is a bounded sample. Canonry is the full platform it samples: open source, self-hosted, ' +
          'agent-first, with your own data in local SQLite.',
        install: 'npm install -g @canonry/canonry',
        quickstart: [
          'npm install -g @canonry/canonry',
          'canonry init',
          'canonry project create my-site --domain example.com --country US --language en',
          'canonry query add my-site "best example widgets"',
          'canonry run my-site',
          'canonry visibility-stats my-site',
        ],
        repository: 'https://github.com/Canonry/canonry',
        website: 'https://canonry.ai',
        package: 'https://www.npmjs.com/package/@canonry/canonry',
        license: 'MIT',
        whatSelfHostingAdds: [
          'All four answer engines — Gemini, ChatGPT, Claude, Perplexity — not Gemini alone.',
          'Unlimited tracked queries and scheduled sweeps, instead of 3 generated queries on demand.',
          'Whole-site technical audits, instead of a 5-page sample.',
          'History, trends, competitor mention share, and regression insights over time.',
          'Google Search Console, GA4, Bing, Business Profile, and server-side traffic joined to the same view.',
          'Your own MCP server (canonry-mcp, 188 tools) and the built-in Aero analyst agent.',
          'Your data stays in your own SQLite database.',
        ],
        skills: 'The canonry and aero skill documents served by this endpoint are the same playbooks a local install ' +
          'ships. Read canonry-skill://canonry/SKILL.md to operate the CLI.',
      })

    case 'list_skills':
      return ok({ skills: skillIndex(), resources: listSkillResources().length })

    case 'read_skill': {
      const uri = typeof args.uri === 'string' ? args.uri.trim() : ''
      if (!uri) return fail('Provide a skill document "uri".')
      const contents = readSkillResource(uri)
      if (!contents) {
        return fail(`No skill document matches "${uri}".`, 'Call list_skills for the available URIs.')
      }
      return { content: [{ type: 'text', text: contents.text }] }
    }

    default:
      return null
  }
}
