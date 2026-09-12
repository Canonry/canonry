/**
 * The MCP tool surface: reads over checks this val has already run, plus the
 * bundled skills for clients that do not implement MCP resources.
 *
 * Every tool but `start_check` is a read, and `start_check` runs the host's full
 * admission path — same global daily cap, same single execution lease, same
 * cache reuse — differing only in that it skips Turnstile, which an agent cannot
 * solve, and spends from its own tighter per-caller bucket. The global cap is
 * what bounds the bill; Turnstile bounds fairness, so this widens who may spend
 * the budget without widening the budget.
 *
 * Results are JSON in a text block rather than `structuredContent`, because
 * every client across both protocol eras renders text content, while typed
 * output is newer and unevenly implemented.
 */
import { type CheckRecord, checkFingerprint, type CheckStore, isCheckExpired } from 'npm:@canonry/val-kit@0.2.0/jobs'
import type { PerceptionEvidence } from 'npm:@canonry/val-kit@0.2.0/perception'
import { readSkillResource } from 'npm:@canonry/val-kit@0.2.0/mcp'
import { normalizePublicDomain, PublicUrlError } from 'npm:@canonry/val-kit@0.2.0/security'
import { CHECK_FINGERPRINT_NAMESPACE, type PerceptionCheckResult } from '../runtime/check-result.ts'

const CHECK_ID = /^[0-9a-f-]{36}$/i

/**
 * The one sentence that keeps this instrument out of the other one's table.
 *
 * Every question here NAMES the brand, so the engine was always going to talk
 * about it: a mention rate over this basket would read ~100% and mean nothing.
 * AI Visibility asks non-brand questions, where placement is actually decided.
 * The two never share a denominator, so the scope travels with every number.
 */
const BRANDED_SCOPE_NOTE =
  'These are branded questions — the brand is named in each one — so the engine was always going to discuss it. ' +
  'The finding is what it SAID, never whether it appeared. Never compare these figures to an AI Visibility ' +
  'mention or citation rate: those are measured on non-brand queries and share no denominator with this.'

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
) => Promise<{ record: CheckRecord<PerceptionCheckResult>; reused: boolean }>

export interface McpToolContext {
  store: CheckStore<PerceptionCheckResult>
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
 * A domain lookup only ever finds work the val already did — it never starts a
 * check — so a miss is reported as a miss rather than quietly queuing paid work
 * the caller did not ask for.
 */
async function resolveCheck(
  context: McpToolContext,
  args: Record<string, unknown>,
): Promise<{ record: CheckRecord<PerceptionCheckResult> } | { error: McpToolResult }> {
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
function recordEnvelope(record: CheckRecord<PerceptionCheckResult>) {
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
 * The headline numbers, passed straight through from the record.
 *
 * Never recomputed here. The summary is what the instrument measured over the
 * rows it wrote; deriving it a second time on the read path is how a tool
 * payload starts disagreeing with the page and with itself.
 */
function perceptionSummary(record: CheckRecord<PerceptionCheckResult>) {
  const perception = record.result?.perception
  if (!perception) return { measured: false as const }
  return {
    measured: true as const,
    scope: 'branded' as const,
    scopeNote: BRANDED_SCOPE_NOTE,
    brandNames: perception.brandNames,
    successfulChecks: perception.summary.successfulChecks,
    failedChecks: perception.summary.failedChecks,
    verdicts: perception.summary.verdicts,
    verdictNote:
      'Counts are over successful checks only and sum to successfulChecks. "none" means the answer took no position, ' +
      'which is a finding; a failed check has a null verdict and is in no denominator.',
    concerns: perception.summary.concerns,
    sourceTypes: perception.summary.sourceTypes,
    sourceNote:
      'Sources the answer engine attributed for these answers, typed. A type counts once per answer, and an answer ' +
      'that attributed nothing is stated as unattributedAnswers rather than folded into the denominator.',
    startedAt: perception.startedAt,
    completedAt: perception.completedAt,
  }
}

function evidenceRow(evidence: PerceptionEvidence) {
  return {
    query: evidence.query,
    provider: evidence.provider,
    servedModel: evidence.servedModel,
    completedAt: evidence.completedAt,
    // Null means this check produced no verdict — a failed probe or a failed
    // extraction. It is never 'none', which says the answer took no position.
    verdict: evidence.verdict,
    // Copied out of the answer and verified present in it, word for word.
    evidenceSentences: evidence.evidenceSentences,
    concerns: evidence.concerns,
    sources: evidence.sources,
    searchQueries: evidence.searchQueries,
    retrievalStatus: evidence.retrievalStatus,
    answerText: evidence.answerText,
    error: evidence.error,
  }
}

/**
 * The conversion path. An agent that has just shown a user what an engine says
 * about their brand is exactly where "how do I get this properly" gets asked,
 * and without this it would have to guess at an install command.
 */
const SELF_HOST_TOOL: McpToolDefinition = {
  name: 'self_host',
  title: 'How to self-host Canonry',
  description:
    'How to run the full Canonry platform instead of this bounded sample: install command, repository, docs, and ' +
    'what self-hosting adds over this endpoint. Call it when the user asks for more engines, scheduled tracking, ' +
    'more questions, their own data, or how any of this actually works.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

const START_CHECK_TOOL: McpToolDefinition = {
  name: 'start_check',
  title: 'Run a new brand perception check',
  description:
    'Run a fresh check for a domain: three grounded Gemini answers to BRANDED questions about the brand, each read ' +
    'back for the position it takes. Blocks until the check finishes, up to about 45 seconds, and returns the same ' +
    'shape as get_check. A domain checked in the last 24 hours with the same questions returns the cached result ' +
    'immediately and costs nothing. Daily limits apply.',
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
          'with branded questions generated for the brand, so supplying none generates all three.',
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
    title: 'Get a brand perception check',
    description:
      'Status and headline numbers for one brand check: how many answers recommend, caution, are mixed, or took no ' +
      'position, the concerns those answers raised, and the mix of source types the engine attributed. Address it by ' +
      'checkId or by domain. Every figure is scoped to BRANDED questions and is never comparable to an AI Visibility ' +
      'mention or citation rate. Reads existing work only — it never starts a new check.',
    inputSchema: TARGET_SCHEMA,
  },
  {
    name: 'get_brand_perception',
    title: 'Get brand perception evidence',
    description:
      'Per answer evidence for one check. Every row carries the verdict the answer gave, the sentences copied out of ' +
      'that answer word for word which carry it, the concerns it wrote, the typed sources the engine attributed, and ' +
      'the full answer text. A null verdict means that check produced none and was not measured — it is never "none", ' +
      'which says the answer took no position. Branded scope; not comparable to AI Visibility rates.',
    inputSchema: TARGET_SCHEMA,
  },
  {
    name: 'read_skill',
    title: 'Read a Canonry skill document',
    description: 'Read one bundled canonry (operator) or aero (analyst) skill document as markdown. Accepts a ' +
      'canonry-skill:// URI or a path such as "aero/references/regression-playbook.md". The full index is served as ' +
      'MCP resources: call resources/list for every available URI, starting with the two SKILL.md entry points.',
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
        brandPerception: perceptionSummary(resolved.record),
        partialErrors: resolved.record.result?.errors ?? [],
      })
    }

    case 'get_brand_perception': {
      const resolved = await resolveCheck(context, args)
      if ('error' in resolved) return resolved.error
      const perception = resolved.record.result?.perception
      if (!perception) {
        return ok({
          ...recordEnvelope(resolved.record),
          measured: false,
          reason: resolved.record.status === 'queued' || resolved.record.status === 'running'
            ? 'The check is still running.'
            : 'This check has no brand perception result.',
        })
      }
      return ok({
        ...recordEnvelope(resolved.record),
        scope: 'branded',
        scopeNote: BRANDED_SCOPE_NOTE,
        summary: perceptionSummary(resolved.record),
        evidence: perception.evidence.map(evidenceRow),
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
          brandPerception: perceptionSummary(record),
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
          'Unlimited tracked questions and scheduled sweeps, instead of 3 branded questions on demand.',
          'History, so you can see a verdict or a concern appear, spread, or go away.',
          'Non-brand tracking as well: mention and citation coverage on the questions that decide placement.',
          'Competitor mention share, regression insights, and a downloadable client report.',
          'Google Search Console, GA4, Bing, Business Profile, and server-side traffic joined to the same view.',
          'Your own MCP server (canonry-mcp, 188 tools) and the built-in Aero analyst agent.',
          'Your data stays in your own SQLite database.',
        ],
        skills: 'The canonry and aero skill documents served by this endpoint are the same playbooks a local install ' +
          'ships. Read canonry-skill://canonry/SKILL.md to operate the CLI.',
      })

    case 'read_skill': {
      const uri = typeof args.uri === 'string' ? args.uri.trim() : ''
      if (!uri) return fail('Provide a skill document "uri".')
      const contents = readSkillResource(uri)
      if (!contents) {
        return fail(`No skill document matches "${uri}".`, 'Call resources/list for the available URIs.')
      }
      return { content: [{ type: 'text', text: contents.text }] }
    }

    default:
      return null
  }
}
