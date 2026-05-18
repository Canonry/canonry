import { complete, type Context } from '@mariozechner/pi-ai'
import {
  actionConfidenceLabel,
  contentActionLabel,
  providerError,
  validationError,
  type ContentTargetRowDto,
  type DemandSource,
} from '@ainyc/canonry-contracts'
import type {
  ExplainContentRecommendationFn,
  ExplainContentRecommendationInput,
  ExplainContentRecommendationResult,
} from '@ainyc/canonry-api-routes'
import type { CanonryConfig } from '../config.js'
import {
  AGENT_PROVIDERS,
  agentProvidersByPriority,
  coerceAgentProvider,
  resolveApiKeyFor,
  resolveModelForCapability,
  type SupportedAgentProvider,
} from './providers.js'

/**
 * Stable prompt version baked into the cache key. Bump this when the
 * template or system prompt changes meaningfully — the cache is keyed
 * by `(projectId, targetRef, promptVersion)`, so a bump invalidates
 * stored explanations forward without requiring a manual purge.
 *
 * Bump checklist: any edit to `SYSTEM_PROMPT`, `buildRecommendationPrompt`,
 * or the rendered context fields counts as a template change.
 */
export const RECOMMENDATION_EXPLAIN_PROMPT_VERSION = 'v1'

const SYSTEM_PROMPT = `You are an AEO (Answer Engine Optimization) analyst explaining why a specific content recommendation matters for a website. Your audience is the site owner or their agency — practical, time-poor, allergic to jargon.

Output requirements:
- 3 to 5 short bullet points, dash-prefixed.
- First bullet: the concrete reason this recommendation surfaced (cite the relevant signal — competitor citations, GSC demand, absence — verbatim from the context).
- Middle bullets: what to do about it. Specific, actionable, ordered by impact.
- Final bullet: the expected outcome if executed (recovered citations, ranking lift, etc.).
- No preamble, no closing pleasantries, no markdown headers.
- Maximum 600 characters total. Be dense.`

/**
 * One dollar = 100 cents = 100,000 millicents. pi-ai returns USD floats;
 * we persist millicents as an integer to dodge float drift and keep
 * sums cheap.
 */
function dollarsToMillicents(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0
  return Math.round(dollars * 100_000)
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown'
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return Math.round(value).toString()
}

function demandSourceLabel(source: DemandSource): string {
  switch (source) {
    case 'gsc': return 'Google Search Console impressions'
    case 'competitor-evidence': return 'competitor citations from AI answer engines'
    case 'both': return 'GSC impressions + competitor citations from AI engines'
  }
}

/**
 * Render a recommendation row as a compact context block the LLM can
 * read in one pass. Keep this stable — the prompt version bump rule
 * assumes any change to the rendered context counts as a template
 * change.
 *
 * Exported for unit tests so we can assert the rendered context without
 * spinning up an LLM call.
 */
export function buildRecommendationPrompt(input: {
  projectName: string
  canonicalDomain: string
  recommendation: ContentTargetRowDto
}): string {
  const { projectName, canonicalDomain, recommendation: r } = input
  const lines: string[] = [
    `Project: ${projectName} (${canonicalDomain})`,
    `Query: "${r.query}"`,
    `Recommended action: ${contentActionLabel(r.action)}`,
    `Action confidence: ${actionConfidenceLabel(r.actionConfidence)}`,
    `Demand signal: ${demandSourceLabel(r.demandSource)}`,
    `Priority score: ${r.score.toFixed(2)}`,
    `Score breakdown — demand: ${r.scoreBreakdown.demand.toFixed(2)}, competitor: ${r.scoreBreakdown.competitor.toFixed(2)}, absence: ${r.scoreBreakdown.absence.toFixed(2)}, gap severity: ${r.scoreBreakdown.gapSeverity.toFixed(2)}`,
  ]
  if (r.drivers.length > 0) {
    lines.push(`Drivers: ${r.drivers.join('; ')}`)
  }
  if (r.ourBestPage) {
    const pos = r.ourBestPage.gscAvgPosition === null
      ? 'unranked'
      : `avg position ${r.ourBestPage.gscAvgPosition.toFixed(1)}`
    lines.push(
      `Our current best page: ${r.ourBestPage.url} ` +
        `(${formatNumber(r.ourBestPage.gscImpressions)} GSC impressions, ` +
        `${formatNumber(r.ourBestPage.gscClicks)} clicks, ${pos}, ` +
        `${formatNumber(r.ourBestPage.organicSessions)} organic sessions)`,
    )
  } else {
    lines.push('Our current best page: none (we do not rank for this query)')
  }
  if (r.winningCompetitor) {
    lines.push(
      `Winning competitor: ${r.winningCompetitor.domain} — ${r.winningCompetitor.title} ` +
        `(${formatNumber(r.winningCompetitor.citationCount)} AI engine citations) — ${r.winningCompetitor.url}`,
    )
  }
  if (r.existingAction) {
    lines.push(
      `Existing work in progress: action ${r.existingAction.actionId} (state: ${r.existingAction.state}, last updated ${r.existingAction.lastUpdated})`,
    )
  }
  return lines.join('\n')
}

/**
 * Pick the provider for an explain call. Priority:
 *   1. Caller override (`providerOverride`), if valid + has a configured key.
 *   2. First configured provider in `agentProvidersByPriority()`.
 *   3. Throw — caller (route handler) maps that to a clean 503.
 *
 * Mirrors `detectAgentProvider` from `session.ts` for symmetry with Aero.
 */
function pickExplainProvider(
  config: CanonryConfig,
  providerOverride?: string,
): SupportedAgentProvider {
  if (providerOverride) {
    const id = coerceAgentProvider(providerOverride)
    if (!id) {
      // User-supplied bad value — 400 VALIDATION_ERROR via the global handler.
      throw validationError(
        `Unknown provider '${providerOverride}'. Valid: ${agentProvidersByPriority().join(', ')}.`,
      )
    }
    if (!resolveApiKeyFor(id, config)) {
      // Caller asked for a specific provider, but its key is missing.
      // 502 PROVIDER_ERROR conveys "the chosen provider can't run."
      throw providerError(
        `Provider '${id}' has no API key configured in ~/.canonry/config.yaml or env.`,
      )
    }
    return id
  }
  for (const provider of agentProvidersByPriority()) {
    if (resolveApiKeyFor(provider, config)) return provider
  }
  const hints = agentProvidersByPriority()
    .map((p) => `${AGENT_PROVIDERS[p].piAiProvider.toUpperCase()}_API_KEY`)
    .join(' / ')
  throw providerError(
    `No LLM provider configured. Add an API key in ~/.canonry/config.yaml or set one of: ${hints}.`,
  )
}

/**
 * Build the `ExplainContentRecommendationFn` injected into the
 * api-routes content plugin. Keeps the api-routes package LLM-agnostic
 * (no pi-ai dependency) while letting the explainer use the same
 * provider/api-key/capability-tier plumbing Aero already relies on.
 *
 * Capability tier `analyze` — mid-tier model chosen by `PROVIDER_MODELS`.
 * One-shot synthesis, no tool use, cheap.
 */
export function createRecommendationExplainer(
  opts: { config: CanonryConfig },
): ExplainContentRecommendationFn {
  return async (input: ExplainContentRecommendationInput): Promise<ExplainContentRecommendationResult> => {
    const provider = pickExplainProvider(opts.config, input.providerOverride)
    const model = resolveModelForCapability(provider, 'analyze', input.modelOverride)

    const prompt = buildRecommendationPrompt({
      projectName: input.projectName,
      canonicalDomain: input.canonicalDomain,
      recommendation: input.recommendation,
    })

    const context: Context = {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
        },
      ],
    }
    const apiKey = resolveApiKeyFor(provider, opts.config)
    const resp = await complete(model, context, apiKey ? { apiKey } : {})
    const parts = resp.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    const text = parts.map((p) => p.text).join('\n').trim()
    if (!text) {
      throw new Error(`Provider '${provider}' returned no text content for recommendation explanation.`)
    }

    return {
      promptVersion: RECOMMENDATION_EXPLAIN_PROMPT_VERSION,
      provider,
      model: model.id,
      responseText: text,
      costMillicents: dollarsToMillicents(resp.usage.cost.total),
    }
  }
}
