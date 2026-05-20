import { AI_ENGINE_DOMAINS } from '@ainyc/canonry-contracts'
import type { AiCrawlerRule, AiReferrerRule } from './types.js'

/**
 * Legacy ChatGPT consumer hostname (redirects to `chatgpt.com` today). Kept
 * separate because referrer headers from older clients still carry it.
 */
const LEGACY_CHATGPT_DOMAIN = 'chat.openai.com'

export const DEFAULT_AI_CRAWLER_RULES: AiCrawlerRule[] = [
  {
    id: 'openai-gptbot',
    operator: 'OpenAI',
    product: 'GPTBot',
    purpose: 'training',
    userAgentPatterns: [/GPTBot\//i],
  },
  {
    id: 'openai-searchbot',
    operator: 'OpenAI',
    product: 'OAI-SearchBot',
    purpose: 'search',
    userAgentPatterns: [/OAI-SearchBot\//i],
  },
  {
    id: 'openai-chatgpt-user',
    operator: 'OpenAI',
    product: 'ChatGPT-User',
    purpose: 'user-agent',
    userAgentPatterns: [/ChatGPT-User\//i],
  },
  {
    id: 'anthropic-claudebot',
    operator: 'Anthropic',
    product: 'ClaudeBot',
    purpose: 'training',
    // Anthropic ships several Claude-* crawlers (ClaudeBot for training,
    // Claude-Web for chat fetches, Claude-SearchBot for search). The
    // `Claude-` prefix + `Bot/` suffix is the stable shape — pattern is
    // permissive enough to catch new Claude-*Bot variants as Anthropic
    // adds them, without matching unrelated UAs that happen to mention
    // "claude". The per-user fetcher `Claude-User` has no `Bot/` suffix
    // and is intentionally NOT matched here — it routes through the
    // separate `claude-user` rule below (purpose: 'user-agent').
    userAgentPatterns: [
      /ClaudeBot\//i,
      /Claude-Web\//i,
      /Claude-SearchBot\//i,
      /Claude-[A-Z]+Bot\//i,
      /anthropic-ai/i,
    ],
  },
  {
    // Anthropic's on-behalf-of-user fetcher: Claude fetches a URL when
    // a person asks about it mid-conversation (citation click, "read
    // this page" prompt). Distinct from ClaudeBot (training crawl) —
    // same operator, opposite operational signal, mirroring OpenAI's
    // GPTBot vs. ChatGPT-User split. The `anthropic-claudebot` rule
    // above does not match `Claude-User/` (its `Claude-[A-Z]+Bot/`
    // pattern needs a `Bot/` suffix), so this is the only rule that
    // routes it — into the user-fetch bucket, not bulk crawl.
    id: 'claude-user',
    operator: 'Anthropic',
    product: 'Claude-User',
    purpose: 'user-agent',
    userAgentPatterns: [/Claude-User\//i],
  },
  {
    id: 'perplexity-bot',
    operator: 'Perplexity',
    product: 'PerplexityBot',
    purpose: 'search',
    userAgentPatterns: [/PerplexityBot\//i],
  },
  {
    // User-initiated fetches when a Perplexity user opens a citation
    // link. Separate from PerplexityBot (crawl) — different ranges and
    // different operational signal. Perplexity publishes both UA
    // patterns at perplexity.ai/perplexity-user.json.
    id: 'perplexity-user',
    operator: 'Perplexity',
    product: 'Perplexity-User',
    purpose: 'user-agent',
    userAgentPatterns: [/Perplexity-User\//i],
  },
  {
    id: 'google-extended',
    operator: 'Google',
    product: 'Google-Extended',
    purpose: 'training-control',
    userAgentPatterns: [/Google-Extended/i],
  },
  {
    id: 'bytespider',
    operator: 'ByteDance',
    product: 'Bytespider',
    purpose: 'training',
    userAgentPatterns: [/Bytespider/i],
  },
  {
    id: 'applebot-extended',
    operator: 'Apple',
    product: 'Applebot-Extended',
    purpose: 'training',
    userAgentPatterns: [/Applebot-Extended/i],
  },
  {
    // Apple's general crawler (separate from Applebot-Extended, which is
    // the training-opt-out signaling UA). Both indexes pages for Apple
    // services (Siri/Spotlight); only Applebot-Extended is gated by
    // training-data opt-out.
    id: 'applebot',
    operator: 'Apple',
    product: 'Applebot',
    purpose: 'crawl',
    userAgentPatterns: [/Applebot\//i],
  },
  {
    id: 'meta-externalagent',
    operator: 'Meta',
    product: 'meta-externalagent',
    purpose: 'training',
    userAgentPatterns: [/meta-externalagent/i],
  },
  {
    id: 'ccbot',
    operator: 'Common Crawl',
    product: 'CCBot',
    purpose: 'crawl',
    userAgentPatterns: [/CCBot\//i],
  },
  {
    id: 'cohere-ai',
    operator: 'Cohere',
    product: 'cohere-ai',
    purpose: 'training',
    userAgentPatterns: [/cohere-ai/i],
  },
  {
    id: 'diffbot',
    operator: 'Diffbot',
    product: 'Diffbot',
    purpose: 'crawl',
    userAgentPatterns: [/Diffbot/i],
  },
  {
    // Per-user, on-demand fetches initiated by a Mistral user (citation
    // click, "read this URL" prompt). Separate from MistralBot (crawl)
    // so the dashboard's user-fetch vs. bulk-crawl split stays honest.
    id: 'mistral-ai-user',
    operator: 'Mistral AI',
    product: 'MistralAI-User',
    purpose: 'user-agent',
    userAgentPatterns: [/MistralAI-User\//i],
  },
  {
    // Mistral's general crawler. Distinct from MistralAI-User (per-user
    // fetch) — same operator, different operational signal.
    id: 'mistral-bot',
    operator: 'Mistral AI',
    product: 'MistralBot',
    purpose: 'crawl',
    userAgentPatterns: [/MistralBot\//i],
  },
  {
    id: 'deepseek',
    operator: 'DeepSeek',
    product: 'DeepSeekBot',
    purpose: 'training',
    userAgentPatterns: [/DeepSeekBot/i],
  },
  {
    id: 'xai-grok-bot',
    operator: 'xAI',
    product: 'xAI-Bot',
    purpose: 'crawl',
    // xAI documents its crawler at https://x.ai/bots/ as `xAI-Bot/<version>`.
    // Operators have also observed `Grok-Bot/...` in production logs. xAI
    // has been less consistent than OpenAI/Anthropic about publishing every
    // UA variant they ship, so the pattern is intentionally permissive
    // across the xAI/Grok family — better to over-match the operator than
    // leave real hits in the `unknown` bucket. A separate `purpose:
    // 'user-agent'` Grok rule can be added later if xAI ships a citation
    // user-fetcher UA (the way OpenAI ships ChatGPT-User alongside GPTBot).
    userAgentPatterns: [/xAI-Bot\//i, /Grok-Bot\//i, /GrokBot\//i],
  },
  // Classic search-engine crawlers. Not strictly "AI" by training origin,
  // but the same audience: machine traffic indexing the site for query
  // surfaces. Operators tracking AI visibility want this signal too —
  // SERP indexing is the upstream that feeds AI answer engines (Bing
  // powers ChatGPT search; Google powers Gemini grounding). Classified
  // alongside LLM crawlers; the dashboard's "AI crawler hits" label is
  // imprecise here but functionally correct (these are still bots, not
  // humans).
  {
    id: 'googlebot',
    operator: 'Google',
    product: 'Googlebot',
    purpose: 'search',
    // Googlebot has Smartphone / Desktop / Image / News / Video variants.
    // All match the `Googlebot/` prefix on first appearance in the UA.
    // Excludes `Googlebot-Image` etc. that ride a `Googlebot-` prefix —
    // they also match `Googlebot/` in their UA strings.
    userAgentPatterns: [/Googlebot[/-]/i],
  },
  {
    id: 'bingbot',
    operator: 'Microsoft',
    product: 'bingbot',
    purpose: 'search',
    userAgentPatterns: [/bingbot\//i],
  },
  {
    id: 'duckduckbot',
    operator: 'DuckDuckGo',
    product: 'DuckDuckBot',
    purpose: 'search',
    userAgentPatterns: [/DuckDuckBot/i],
  },
  {
    id: 'yandexbot',
    operator: 'Yandex',
    product: 'YandexBot',
    purpose: 'search',
    userAgentPatterns: [/YandexBot\//i],
  },
  {
    id: 'baiduspider',
    operator: 'Baidu',
    product: 'Baiduspider',
    purpose: 'search',
    userAgentPatterns: [/Baiduspider/i],
  },
  {
    id: 'amazonbot',
    operator: 'Amazon',
    product: 'Amazonbot',
    purpose: 'crawl',
    userAgentPatterns: [/Amazonbot\//i],
  },
]

export const DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS = [
  'GPTBot/',
  'OAI-SearchBot/',
  'ChatGPT-User/',
  'ClaudeBot/',
  'Claude-Web/',
  'Claude-SearchBot/',
  'Claude-User/',
  'anthropic-ai',
  'PerplexityBot/',
  'Google-Extended',
  'Bytespider',
  'Applebot-Extended',
  'Applebot/',
  'meta-externalagent',
  'CCBot/',
  'cohere-ai',
  'Diffbot',
  'MistralAI-User/',
  'MistralBot/',
  'DeepSeekBot',
  'xAI-Bot/',
  'Grok-Bot/',
  'GrokBot/',
  'Googlebot',
  'bingbot/',
  'DuckDuckBot',
  'YandexBot/',
  'Baiduspider',
  'Amazonbot/',
  'Perplexity-User/',
]

export const DEFAULT_AI_REFERRER_RULES: AiReferrerRule[] = [
  { domain: AI_ENGINE_DOMAINS.chatgpt, operator: 'OpenAI', product: 'ChatGPT' },
  { domain: LEGACY_CHATGPT_DOMAIN, operator: 'OpenAI', product: 'ChatGPT' },
  { domain: AI_ENGINE_DOMAINS.perplexity, operator: 'Perplexity', product: 'Perplexity' },
  { domain: AI_ENGINE_DOMAINS.claude, operator: 'Anthropic', product: 'Claude' },
  { domain: AI_ENGINE_DOMAINS.gemini, operator: 'Google', product: 'Gemini' },
  { domain: AI_ENGINE_DOMAINS.copilotMicrosoft, operator: 'Microsoft', product: 'Copilot' },
  { domain: AI_ENGINE_DOMAINS.grok, operator: 'xAI', product: 'Grok' },
  { domain: AI_ENGINE_DOMAINS.phind, operator: 'Phind', product: 'Phind' },
  { domain: AI_ENGINE_DOMAINS.you, operator: 'You.com', product: 'You.com' },
  { domain: AI_ENGINE_DOMAINS.metaAi, operator: 'Meta', product: 'Meta AI' },
]
