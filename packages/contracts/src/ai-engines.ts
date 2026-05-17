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
