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
  /**
   * The engine's official Android app ids (Google Play package names), matched
   * exactly. GA4 stores an in-app link's source as the bare id or as
   * `android-app://<id>`, and both resolve, so the Copilot and Gemini apps map
   * although their names are not `labels`.
   */
  appIds: readonly string[]
}

/**
 * The mapping from an analytics source string to an AI engine. Every reader
 * that attributes GA4 `sessionSource` (or any referrer / `utm_source` value)
 * to an engine goes through `aiEngineForReferralSource`, so two engine
 * breakdowns never bucket the same source differently.
 *
 * The GA4 AI referral sync builds the filters it selects rows with from these
 * definitions (`AI_REFERRAL_SOURCE_FILTERS` in integration-google-analytics):
 * each host and its subdomains, each bare name, each app id (bare or as
 * `android-app://`), and, for engines with `labels`, tags that start with the
 * name or host. A tag with the name further in (`utm_chatgpt`), an app id
 * matched only by a label (`com.openai.example`) or a URL typed as
 * `utm_source` maps here but is not selected there unless GA4 files it under
 * its AI Assistant channel. `openai.com` and `anthropic.com` map to
 * ChatGPT and Claude because that sync counts them as AI traffic too.
 */
export const AI_REFERRAL_ENGINE_DEFINITIONS: readonly AiReferralEngineDefinition[] = [
  {
    engine: AiReferralEngines.chatgpt,
    label: 'ChatGPT',
    domains: [AI_ENGINE_DOMAINS.chatgpt, AI_ENGINE_DOMAINS.chatgptLegacy, AI_ENGINE_DOMAINS.openai],
    tokens: ['chatgpt', 'openai'],
    labels: ['chatgpt', 'openai'],
    appIds: ['com.openai.chatgpt'],
  },
  {
    engine: AiReferralEngines.perplexity,
    label: 'Perplexity',
    domains: [AI_ENGINE_DOMAINS.perplexity],
    tokens: ['perplexity'],
    labels: ['perplexity'],
    appIds: ['ai.perplexity.app.android'],
  },
  {
    engine: AiReferralEngines.gemini,
    label: 'Gemini',
    domains: [AI_ENGINE_DOMAINS.gemini, AI_ENGINE_DOMAINS.bard],
    tokens: ['gemini', 'bard'],
    labels: [],
    appIds: ['com.google.android.apps.bard'],
  },
  {
    engine: AiReferralEngines.claude,
    label: 'Claude',
    domains: [AI_ENGINE_DOMAINS.claude, ANTHROPIC_API_DOMAIN],
    tokens: ['claude', 'anthropic'],
    labels: ['claude', 'anthropic'],
    appIds: ['com.anthropic.claude'],
  },
  {
    engine: AiReferralEngines.copilot,
    label: 'Copilot',
    domains: [AI_ENGINE_DOMAINS.copilotMicrosoft, AI_ENGINE_DOMAINS.copilot],
    tokens: ['copilot'],
    labels: [],
    // Off Google Play since 2026, but installed apps still send it. copilot.com
    // now links the Microsoft 365 app (`com.microsoft.office.officehubrow`),
    // which also opens Office documents, so its links are not all AI traffic.
    appIds: ['com.microsoft.copilot'],
  },
  {
    engine: AiReferralEngines.grok,
    label: 'Grok',
    domains: [AI_ENGINE_DOMAINS.grok],
    tokens: ['grok'],
    labels: [],
    appIds: ['ai.x.grok'],
  },
  {
    engine: AiReferralEngines.deepseek,
    label: 'DeepSeek',
    domains: [AI_ENGINE_DOMAINS.deepseek],
    tokens: ['deepseek'],
    labels: ['deepseek'],
    appIds: ['com.deepseek.chat'],
  },
  {
    engine: AiReferralEngines['meta-ai'],
    label: 'Meta AI',
    domains: [AI_ENGINE_DOMAINS.metaAi],
    tokens: [],
    labels: [],
    appIds: ['com.facebook.stella'],
  },
  {
    engine: AiReferralEngines.phind,
    label: 'Phind',
    domains: [AI_ENGINE_DOMAINS.phind],
    tokens: ['phind'],
    labels: ['phind'],
    appIds: [],
  },
  {
    engine: AiReferralEngines['you-com'],
    label: 'You.com',
    domains: [AI_ENGINE_DOMAINS.you],
    tokens: [],
    labels: [],
    appIds: [],
  },
]

const ENGINE_BY_TOKEN = new Map<string, AiReferralEngine>(
  AI_REFERRAL_ENGINE_DEFINITIONS.flatMap(definition => (
    definition.tokens.map(token => [token, definition.engine] as const)
  )),
)

const ENGINE_BY_APP_ID = new Map<string, AiReferralEngine>(
  AI_REFERRAL_ENGINE_DEFINITIONS.flatMap(definition => (
    definition.appIds.map(appId => [appId, definition.engine] as const)
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
  // `android-app://com.microsoft.copilot` parses to the bare id as its host.
  const byAppId = host ? ENGINE_BY_APP_ID.get(host) : undefined
  if (byAppId) return byAppId
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
