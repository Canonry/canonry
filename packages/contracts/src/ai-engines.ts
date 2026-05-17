/**
 * Canonical hostnames for AI answer engines. Centralized so source code and
 * tests share one truth — production code (citation filters, normalization)
 * and tests (assertions, fixtures) import from here instead of repeating raw
 * string literals.
 *
 * Adding a new engine: extend `AI_ENGINE_DOMAINS` and (if it serves multiple
 * surface domains like `chatgpt.com` + `openai.com`) add an entry to
 * `AI_ENGINE_SELF_DOMAINS` so the citation extractors filter it out.
 *
 * ESLint blocks raw use of these hostnames outside this file and test
 * directories via `no-restricted-syntax` in the workspace config.
 */
export const AI_ENGINE_DOMAINS = {
  /** OpenAI marketing/blog/API surface. */
  openai: 'openai.com',
  /** ChatGPT consumer surface (separate from openai.com per OpenAI's domain split). */
  chatgpt: 'chatgpt.com',
  /** Anthropic's Claude consumer surface. */
  claude: 'claude.ai',
  /** Perplexity consumer + docs surface. */
  perplexity: 'perplexity.ai',
  /** Google Gemini consumer surface. */
  gemini: 'gemini.google.com',
  /** Google Bard (legacy alias for Gemini surface). */
  bard: 'bard.google.com',
  /** Microsoft Copilot consumer surface. */
  copilotMicrosoft: 'copilot.microsoft.com',
  /** Meta AI consumer surface. */
  metaAi: 'meta.ai',
  /** xAI Grok. */
  grok: 'grok.com',
  /** You.com. */
  you: 'you.com',
  /** Phind. */
  phind: 'phind.com',
} as const

export type AiEngineKey = keyof typeof AI_ENGINE_DOMAINS
export type AiEngineDomain = (typeof AI_ENGINE_DOMAINS)[AiEngineKey]

/**
 * Per-engine list of self-domains that should be excluded from a captured
 * citation set (the engine's own pages aren't third-party sources). When a
 * provider's UI links back to its parent brand, include both — e.g. ChatGPT
 * links to both `chatgpt.com` and `openai.com`.
 */
export const AI_ENGINE_SELF_DOMAINS = {
  chatgpt: [AI_ENGINE_DOMAINS.chatgpt, AI_ENGINE_DOMAINS.openai] as readonly string[],
  claude: [AI_ENGINE_DOMAINS.claude] as readonly string[],
  perplexity: [AI_ENGINE_DOMAINS.perplexity] as readonly string[],
  gemini: [AI_ENGINE_DOMAINS.gemini, AI_ENGINE_DOMAINS.bard] as readonly string[],
} as const

/** Anthropic corporate / API domain. Covers `api.anthropic.com`, `docs.anthropic.com`. */
export const ANTHROPIC_API_DOMAIN = 'anthropic.com'

/** Google APIs umbrella domain. Covers every `*.googleapis.com` API host. */
export const GOOGLE_APIS_DOMAIN = 'googleapis.com'

/**
 * Gemini grounding redirect proxy — Gemini wraps every grounding source URL
 * behind `https://vertexaisearch.cloud.google.com/grounding-api-redirect/<base64>`,
 * so providers that consume Gemini metadata need to recognize and unwrap it.
 */
export const VERTEX_AI_SEARCH_PROXY_DOMAIN = 'vertexaisearch.cloud.google.com'

/**
 * Corporate / API / redirect-proxy domains owned by AI providers themselves.
 * These are NOT the consumer-facing engine surfaces (`chatgpt.com`,
 * `claude.ai`) but the parent brand or infrastructure domains that appear in
 * grounding sources as noise. Use this set to filter provider-owned
 * infrastructure out of citation extraction.
 *
 * Matched as eTLD+1: a callsite typically tests
 * `host === d || host.endsWith('.' + d)` so an entry of `anthropic.com`
 * catches `api.anthropic.com`, `docs.anthropic.com`, etc.
 */
export const AI_PROVIDER_INFRA_DOMAINS = [
  AI_ENGINE_DOMAINS.openai,
  AI_ENGINE_DOMAINS.chatgpt,
  ANTHROPIC_API_DOMAIN,
  GOOGLE_APIS_DOMAIN,
  VERTEX_AI_SEARCH_PROXY_DOMAIN,
] as const
