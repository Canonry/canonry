import { z } from 'zod'
import { AI_ENGINE_DOMAINS, ANTHROPIC_API_DOMAIN } from './ai-engines.js'
import { hostMatchesAnyDomain, hostOf } from './url-normalize.js'

/**
 * The AI answer engines an analytics referral source can be attributed to.
 *
 * These are engine identities for traffic and lead attribution (which engine
 * sent the visitor), not the providers Canonry sweeps (`PROVIDER_NAMES`).
 */
export const aiReferralEngineSchema = z.enum([
  'chatgpt',
  'perplexity',
  'gemini',
  'claude',
  'copilot',
  'grok',
  'deepseek',
  'meta-ai',
  'phind',
  'you-com',
])
export type AiReferralEngine = z.infer<typeof aiReferralEngineSchema>
export const AiReferralEngines = aiReferralEngineSchema.enum

export interface AiReferralEngineDefinition {
  engine: AiReferralEngine
  /** Display name for human output. */
  label: string
  /** Hostnames matched exactly or as a parent domain (`www.` and subdomains included). */
  domains: readonly string[]
  /**
   * Bare `utm_source` labels matched exactly, case-insensitively. Only labels
   * that name the engine unambiguously: `meta` and `you` are left out because
   * they also name ad platforms and ordinary campaign tags.
   */
  tokens: readonly string[]
  /**
   * Labels matched inside an app id or a campaign tag (see
   * `aiEngineForReferralSource`), so `com.openai.chatgpt` and `perplexity_ai`
   * resolve. Only names no other product or ordinary site uses: `gemini`
   * (an exchange), `copilot` (other assistants and apps), `grok` and `bard`
   * stay out.
   */
  labels: readonly string[]
}

/**
 * The mapping from an analytics source string to an AI engine. Every reader
 * that attributes GA4 `sessionSource` (or any referrer / `utm_source` value)
 * to an engine goes through `aiEngineForReferralSource`, so two engine
 * breakdowns never bucket the same source differently.
 *
 * It is stricter than the substring filters the GA4 AI referral sync selects
 * rows with (`AI_REFERRAL_SOURCE_FILTERS` in integration-google-analytics):
 * a source that only contains an engine name inside an ordinary hostname,
 * such as `copilot.example.com`, counts as AI traffic there and returns null
 * here. `openai.com` and `anthropic.com` map to ChatGPT and Claude because
 * that sync counts them as AI traffic too.
 */
export const AI_REFERRAL_ENGINE_DEFINITIONS: readonly AiReferralEngineDefinition[] = [
  {
    engine: AiReferralEngines.chatgpt,
    label: 'ChatGPT',
    domains: [AI_ENGINE_DOMAINS.chatgpt, AI_ENGINE_DOMAINS.chatgptLegacy, AI_ENGINE_DOMAINS.openai],
    tokens: ['chatgpt', 'openai'],
    labels: ['chatgpt', 'openai'],
  },
  {
    engine: AiReferralEngines.perplexity,
    label: 'Perplexity',
    domains: [AI_ENGINE_DOMAINS.perplexity],
    tokens: ['perplexity'],
    labels: ['perplexity'],
  },
  {
    engine: AiReferralEngines.gemini,
    label: 'Gemini',
    domains: [AI_ENGINE_DOMAINS.gemini, AI_ENGINE_DOMAINS.bard],
    tokens: ['gemini', 'bard'],
    labels: [],
  },
  {
    engine: AiReferralEngines.claude,
    label: 'Claude',
    domains: [AI_ENGINE_DOMAINS.claude, ANTHROPIC_API_DOMAIN],
    tokens: ['claude', 'anthropic'],
    labels: ['claude', 'anthropic'],
  },
  {
    engine: AiReferralEngines.copilot,
    label: 'Copilot',
    domains: [AI_ENGINE_DOMAINS.copilotMicrosoft, AI_ENGINE_DOMAINS.copilot],
    tokens: ['copilot'],
    labels: [],
  },
  {
    engine: AiReferralEngines.grok,
    label: 'Grok',
    domains: [AI_ENGINE_DOMAINS.grok],
    tokens: ['grok'],
    labels: [],
  },
  {
    engine: AiReferralEngines.deepseek,
    label: 'DeepSeek',
    domains: [AI_ENGINE_DOMAINS.deepseek],
    tokens: ['deepseek'],
    labels: ['deepseek'],
  },
  {
    engine: AiReferralEngines['meta-ai'],
    label: 'Meta AI',
    domains: [AI_ENGINE_DOMAINS.metaAi],
    tokens: [],
    labels: [],
  },
  {
    engine: AiReferralEngines.phind,
    label: 'Phind',
    domains: [AI_ENGINE_DOMAINS.phind],
    tokens: ['phind'],
    labels: ['phind'],
  },
  {
    engine: AiReferralEngines['you-com'],
    label: 'You.com',
    domains: [AI_ENGINE_DOMAINS.you],
    tokens: [],
    labels: [],
  },
]

const ENGINE_BY_TOKEN = new Map<string, AiReferralEngine>(
  AI_REFERRAL_ENGINE_DEFINITIONS.flatMap(definition => (
    definition.tokens.map(token => [token, definition.engine] as const)
  )),
)

const ENGINE_BY_LABEL = new Map<string, AiReferralEngine>(
  AI_REFERRAL_ENGINE_DEFINITIONS.flatMap(definition => (
    definition.labels.map(label => [label, definition.engine] as const)
  )),
)

/** First labels of a reverse-DNS app id (`com.openai.chatgpt`, `ai.perplexity.app.android`). */
const APP_ID_ROOT_LABELS = new Set(['com', 'org', 'net', 'io', 'ai'])

/**
 * The labels of a source that is an app id or a campaign tag, or null for an
 * ordinary hostname or URL. A tag carries an underscore, which no hostname
 * does, and no slash (`perplexity_ai`, `chatgpt.com_ads`). An app id is a
 * host of three or more labels that starts with a reverse-DNS root
 * (`com.openai.chatgpt`, which GA4 also stores as
 * `android-app://com.openai.chatgpt`). An ordinary hostname such as
 * `chatgpt.com.example.com` is not split, so a lookalike host does not match
 * on one of its labels.
 */
function appOrTagLabels(value: string, host: string | null): string[] | null {
  if (value.includes('_') && !value.includes('/')) return value.split(/[^a-z0-9-]+/).filter(Boolean)
  const hostLabels = host?.split('.') ?? []
  if (hostLabels.length >= 3 && APP_ID_ROOT_LABELS.has(hostLabels[0]!)) return hostLabels
  return null
}

const LABEL_BY_ENGINE = new Map<AiReferralEngine, string>(
  AI_REFERRAL_ENGINE_DEFINITIONS.map(definition => [definition.engine, definition.label]),
)

/**
 * The AI engine an analytics source string belongs to, or null when it is not
 * a known AI engine.
 *
 * Accepts what GA4 stores as `sessionSource` and what a referrer or
 * `utm_source` carries: a hostname in any case (`ChatGPT.com`,
 * `www.perplexity.ai`), a subdomain (`chat.deepseek.com`), a full URL, a bare
 * label (`perplexity`, `openai`), a mobile app id (`com.openai.chatgpt`,
 * `android-app://com.anthropic.claude`) or an underscore campaign tag
 * (`perplexity_ai`). GA4 placeholders such as `(direct)` and `(not set)`, and
 * every other source (`google`, `bing.com`), return null. Hostnames match on
 * a domain boundary, so `notchatgpt.com` is not ChatGPT.
 */
export function aiEngineForReferralSource(source: string | null | undefined): AiReferralEngine | null {
  if (source == null) return null
  const value = source.trim().toLowerCase()
  if (!value || value.startsWith('(')) return null
  const byToken = ENGINE_BY_TOKEN.get(value)
  if (byToken) return byToken
  const host = value.includes('.') ? hostOf(value) : null
  const byDomain = host
    ? AI_REFERRAL_ENGINE_DEFINITIONS.find(definition => (
        hostMatchesAnyDomain(host, definition.domains)
      ))?.engine
    : undefined
  if (byDomain) return byDomain
  const labels = appOrTagLabels(value, host)
  if (!labels) return null
  for (const label of labels) {
    const byLabel = ENGINE_BY_LABEL.get(label)
    if (byLabel) return byLabel
  }
  return null
}

/** Display name for an AI engine id (`chatgpt` reads `ChatGPT`). */
export function aiReferralEngineLabel(engine: AiReferralEngine): string {
  return LABEL_BY_ENGINE.get(engine) ?? engine
}

/**
 * GA4's default channel group for sessions from AI assistants. It names no
 * engine, so a row in it whose source matches no engine is still AI traffic,
 * just unattributed.
 */
export const GA4_AI_ASSISTANT_CHANNEL_GROUP = 'AI Assistant'

/** True for GA4's AI Assistant channel group, in any case or spacing. */
export function isGa4AiAssistantChannel(channelGroup: string | null | undefined): boolean {
  return (channelGroup ?? '').trim().toLowerCase() === GA4_AI_ASSISTANT_CHANNEL_GROUP.toLowerCase()
}
