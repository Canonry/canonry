import { AI_ENGINE_DOMAINS } from '@ainyc/canonry-contracts'
import type { AiCrawlerRule, AiReferrerRule } from './types.js'

/**
 * User-agents belonging to Canonry's own tooling. These hit client sites as a
 * side effect of running an AEO audit / sweep (e.g. `aeo-audit --sitemap`
 * crawls sitemap.xml, robots.txt, llms.txt, and inner pages) and are NOT real
 * visitors or third-party crawlers. Events matching these are dropped from the
 * traffic rollup so our own measurement tooling never inflates a client's
 * crawler / unknown / total counts. Kept deliberately specific so a real UA
 * that merely mentions "canonry" is not swept up.
 */
export const SELF_TRAFFIC_USER_AGENT_PATTERNS: RegExp[] = [
  /AINYC-AEO-Audit\//i,
]

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
    // OpenAI's ads landing-page crawler. It has a dedicated publisher range
    // manifest and is neither GPTBot training traffic nor a per-user fetch.
    id: 'openai-adsbot',
    operator: 'OpenAI',
    product: 'OAI-AdsBot',
    purpose: 'ad-validation',
    userAgentPatterns: [/OAI-AdsBot\//i],
  },
  {
    id: 'openai-chatgpt-user',
    operator: 'OpenAI',
    product: 'ChatGPT-User',
    purpose: 'user-agent',
    userAgentPatterns: [/ChatGPT-User\//i],
  },
  {
    // Observed MCP requests from ChatGPT integrations use this UA. OpenAI's
    // official IP guide publishes a shared integrations range list (plugins,
    // connectors, GPT Actions, and agentic commerce), but does not establish
    // the UA as an authentication contract; UA + range is analytics evidence.
    id: 'openai-chatgpt-connector',
    operator: 'OpenAI',
    product: 'ChatGPT Integrations',
    purpose: 'user-agent',
    userAgentPatterns: [/openai-mcp\//i],
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
    // On-demand fetches performed while answering a Perplexity user's query.
    // Separate from PerplexityBot (crawl) — different ranges and a different
    // operational signal.
    id: 'perplexity-user',
    operator: 'Perplexity',
    product: 'Perplexity-User',
    purpose: 'user-agent',
    userAgentPatterns: [/Perplexity-User\//i],
  },
  {
    // Parallel's search/index crawler. The user-triggered Shap-User surface
    // is a distinct rule because Parallel publishes a range list only for
    // ShapBot today.
    id: 'parallel-shapbot',
    operator: 'Parallel',
    product: 'ShapBot',
    purpose: 'search',
    userAgentPatterns: [/ShapBot\//i],
  },
  {
    id: 'parallel-shap-user',
    operator: 'Parallel',
    product: 'Shap-User',
    purpose: 'user-agent',
    userAgentPatterns: [/Shap-User\//i],
  },
  {
    // Google-Agent navigates the web and acts upon a user's request (for
    // example, Project Mariner), so it belongs in the user-fetch channel. Its
    // browser-like UA carries a `compatible; Google-Agent;` token. This is
    // distinct from the Gemini Notebook fetcher below; Google-Extended is only
    // a robots.txt control token and never makes an HTTP request.
    id: 'google-agent',
    operator: 'Google',
    product: 'Google-Agent',
    purpose: 'user-agent',
    userAgentPatterns: [/Google-Agent/i],
  },
  {
    // NotebookLM/Gemini notebook fetches happen on a user's request. Google
    // renamed the UA and documents both tokens during the transition.
    id: 'google-gemini-notebook',
    operator: 'Google',
    product: 'Google-GeminiNotebook',
    purpose: 'user-agent',
    userAgentPatterns: [/Google-GeminiNotebook/i, /Google-NotebookLM/i],
  },
  {
    // Vertex AI's crawler uses Google's common crawler ranges, but has its own
    // UA so it remains distinguishable from Googlebot in traffic reporting.
    id: 'google-cloudvertexbot',
    operator: 'Google',
    product: 'Google-CloudVertexBot',
    purpose: 'crawl',
    userAgentPatterns: [/Google-CloudVertexBot/i],
  },
  {
    id: 'bytespider',
    operator: 'ByteDance',
    product: 'Bytespider',
    purpose: 'training',
    userAgentPatterns: [/Bytespider/i],
  },
  {
    // Applebot-Extended is a robots.txt data-use token and never makes HTTP
    // requests, so only the actual Applebot crawler belongs in this list.
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
    // Mistral's search-index crawler. Unlike the legacy MistralBot UA below,
    // Mistral publishes a dedicated range manifest for this current token.
    id: 'mistral-ai-index',
    operator: 'Mistral AI',
    product: 'MistralAI-Index',
    purpose: 'search',
    userAgentPatterns: [/MistralAI-Index\//i],
  },
  {
    // Mistral documents this training crawler but does not publish an IP
    // manifest for it, so matching requests remain claimed_unverified.
    id: 'mistral-ai-training',
    operator: 'Mistral AI',
    product: 'MistralAI-Training',
    purpose: 'training',
    userAgentPatterns: [/MistralAI-Training\//i],
  },
  {
    // Preserve classification for the older MistralBot token observed in
    // historical traffic. It is not covered by Mistral's current manifests.
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
  {
    // You.com authenticates YouBot with HTTP Message Signatures rather than a
    // publisher IP manifest. Canonry does not verify signatures yet, so this
    // official UA is classified but remains claimed_unverified.
    id: 'you-youbot',
    operator: 'You.com',
    product: 'YouBot',
    purpose: 'search',
    userAgentPatterns: [/YouBot\//i],
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
    // DuckDuckGo's crawler for cited AI-assisted answers. It shares ranges
    // with DuckDuckBot today, but the publisher exposes a separate manifest.
    id: 'duckassistbot',
    operator: 'DuckDuckGo',
    product: 'DuckAssistBot',
    purpose: 'search',
    userAgentPatterns: [/DuckAssistBot/i],
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
    purpose: 'training',
    userAgentPatterns: [/Amazonbot\//i],
  },
  {
    id: 'amzn-searchbot',
    operator: 'Amazon',
    product: 'Amzn-SearchBot',
    purpose: 'search',
    userAgentPatterns: [/Amzn-SearchBot\//i],
  },
  {
    id: 'amzn-user',
    operator: 'Amazon',
    product: 'Amzn-User',
    purpose: 'user-agent',
    userAgentPatterns: [/Amzn-User\//i],
  },
]

export const DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS = [
  'GPTBot/',
  'OAI-SearchBot/',
  'OAI-AdsBot/',
  'ChatGPT-User/',
  'openai-mcp/',
  'ClaudeBot/',
  'Claude-Web/',
  'Claude-SearchBot/',
  'Claude-User/',
  'anthropic-ai',
  'PerplexityBot/',
  'Perplexity-User/',
  'ShapBot/',
  'Shap-User/',
  'Google-Agent',
  'Google-GeminiNotebook',
  'Google-NotebookLM',
  'Google-CloudVertexBot',
  'Bytespider',
  'Applebot/',
  'meta-externalagent',
  'CCBot/',
  'cohere-ai',
  'Diffbot',
  'MistralAI-User/',
  'MistralAI-Index/',
  'MistralAI-Training/',
  'MistralBot/',
  'DeepSeekBot',
  'xAI-Bot/',
  'Grok-Bot/',
  'GrokBot/',
  'YouBot/',
  'Googlebot',
  'bingbot/',
  'DuckDuckBot',
  'DuckAssistBot',
  'YandexBot/',
  'Baiduspider',
  'Amazonbot/',
  'Amzn-SearchBot/',
  'Amzn-User/',
]

export const DEFAULT_AI_REFERRER_RULES: AiReferrerRule[] = [
  { domain: AI_ENGINE_DOMAINS.chatgpt, operator: 'OpenAI', product: 'ChatGPT' },
  { domain: AI_ENGINE_DOMAINS.chatgptLegacy, operator: 'OpenAI', product: 'ChatGPT' },
  { domain: AI_ENGINE_DOMAINS.perplexity, operator: 'Perplexity', product: 'Perplexity' },
  { domain: AI_ENGINE_DOMAINS.claude, operator: 'Anthropic', product: 'Claude' },
  { domain: AI_ENGINE_DOMAINS.gemini, operator: 'Google', product: 'Gemini' },
  { domain: AI_ENGINE_DOMAINS.copilotMicrosoft, operator: 'Microsoft', product: 'Copilot' },
  { domain: AI_ENGINE_DOMAINS.grok, operator: 'xAI', product: 'Grok' },
  { domain: AI_ENGINE_DOMAINS.phind, operator: 'Phind', product: 'Phind' },
  { domain: AI_ENGINE_DOMAINS.you, operator: 'You.com', product: 'You.com' },
  { domain: AI_ENGINE_DOMAINS.metaAi, operator: 'Meta', product: 'Meta AI' },
]
