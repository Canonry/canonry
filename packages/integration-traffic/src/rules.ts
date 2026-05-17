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
    userAgentPatterns: [/ClaudeBot\//i, /Claude-Web\//i, /anthropic-ai/i],
  },
  {
    id: 'perplexity-bot',
    operator: 'Perplexity',
    product: 'PerplexityBot',
    purpose: 'search',
    userAgentPatterns: [/PerplexityBot\//i],
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
    id: 'mistral-ai',
    operator: 'Mistral AI',
    product: 'MistralAI-User',
    purpose: 'crawl',
    userAgentPatterns: [/MistralAI/i],
  },
]

export const DEFAULT_AI_CRAWLER_USER_AGENT_SUBSTRINGS = [
  'GPTBot/',
  'OAI-SearchBot/',
  'ChatGPT-User/',
  'ClaudeBot/',
  'Claude-Web/',
  'anthropic-ai',
  'PerplexityBot/',
  'Google-Extended',
  'Bytespider',
  'Applebot-Extended',
  'meta-externalagent',
  'CCBot/',
  'cohere-ai',
  'Diffbot',
  'MistralAI',
]

export const DEFAULT_AI_REFERRER_RULES: AiReferrerRule[] = [
  { domain: AI_ENGINE_DOMAINS.chatgpt, operator: 'OpenAI', product: 'ChatGPT' },
  { domain: LEGACY_CHATGPT_DOMAIN, operator: 'OpenAI', product: 'ChatGPT' },
  { domain: AI_ENGINE_DOMAINS.perplexity, operator: 'Perplexity', product: 'Perplexity' },
  { domain: AI_ENGINE_DOMAINS.claude, operator: 'Anthropic', product: 'Claude' },
  { domain: AI_ENGINE_DOMAINS.gemini, operator: 'Google', product: 'Gemini' },
  { domain: AI_ENGINE_DOMAINS.copilotMicrosoft, operator: 'Microsoft', product: 'Copilot' },
  { domain: AI_ENGINE_DOMAINS.phind, operator: 'Phind', product: 'Phind' },
  { domain: AI_ENGINE_DOMAINS.you, operator: 'You.com', product: 'You.com' },
  { domain: AI_ENGINE_DOMAINS.metaAi, operator: 'Meta', product: 'Meta AI' },
]
