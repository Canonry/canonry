import { describe, expect, it } from 'vitest'
import {
  AI_REFERRAL_ENGINE_DEFINITIONS,
  aiEngineForReferralSource,
  aiReferralEngineLabel,
  aiReferralEngineSchema,
  isGa4AiAssistantChannel,
} from '../src/index.js'

describe('aiEngineForReferralSource', () => {
  it.each([
    // GA4 sessionSource values as stored: referrer hosts, utm_source tags, mixed case.
    ['chatgpt.com', 'chatgpt'],
    ['ChatGPT.com', 'chatgpt'],
    ['  chatgpt.com  ', 'chatgpt'],
    ['chat.openai.com', 'chatgpt'],
    ['chatgpt', 'chatgpt'],
    ['openai', 'chatgpt'],
    ['OpenAI', 'chatgpt'],
    ['https://chatgpt.com/c/abc123', 'chatgpt'],
    ['perplexity.ai', 'perplexity'],
    ['www.perplexity.ai', 'perplexity'],
    ['perplexity', 'perplexity'],
    ['gemini.google.com', 'gemini'],
    ['bard.google.com', 'gemini'],
    ['gemini', 'gemini'],
    ['claude.ai', 'claude'],
    ['claude', 'claude'],
    ['anthropic', 'claude'],
    ['copilot.microsoft.com', 'copilot'],
    ['copilot.com', 'copilot'],
    ['copilot', 'copilot'],
    ['grok.com', 'grok'],
    ['chat.deepseek.com', 'deepseek'],
    ['deepseek', 'deepseek'],
    ['meta.ai', 'meta-ai'],
    ['www.meta.ai', 'meta-ai'],
    ['phind.com', 'phind'],
    ['you.com', 'you-com'],
    // Mobile app ids GA4 stores as the source of an in-app link.
    ['com.openai.chatgpt', 'chatgpt'],
    ['android-app://com.openai.chatgpt', 'chatgpt'],
    ['android-app://com.openai.chatgpt/', 'chatgpt'],
    ['ai.perplexity.app.android', 'perplexity'],
    ['com.anthropic.claude', 'claude'],
    ['com.deepseek.chat', 'deepseek'],
    // Underscore campaign tags.
    ['perplexity_ai', 'perplexity'],
    ['chatgpt.com_ads', 'chatgpt'],
  ] as const)('maps %j to %s', (source, engine) => {
    expect(aiEngineForReferralSource(source)).toBe(engine)
  })

  it.each([
    '(direct)',
    '(not set)',
    'google',
    'google.com',
    'bing.com',
    'microsoft.com',
    'facebook.com',
    // Ambiguous short tags: Meta ads and generic campaign tags, not Meta AI or You.com.
    'meta',
    'you',
    // Domain boundary: a lookalike host is not the engine.
    'notchatgpt.com',
    'chatgpt.com.example.com',
    'claude.example.com',
    'example.com',
    // App ids and tags only match unambiguous names: other apps, and names
    // that also belong to non-AI products, stay out.
    'com.google.android.gm',
    'com.example.gemini',
    'com.microsoft.copilot',
    'gemini_exchange',
    'jean-claude',
    // A URL is matched on its host, never on a path segment.
    'https://example.com/chatgpt_ref',
    '',
    '   ',
  ])('does not treat %j as an AI engine', (source) => {
    expect(aiEngineForReferralSource(source)).toBeNull()
  })

  it('returns null for missing sources', () => {
    expect(aiEngineForReferralSource(null)).toBeNull()
    expect(aiEngineForReferralSource(undefined)).toBeNull()
  })

  it('defines every engine exactly once with a display label', () => {
    const defined = AI_REFERRAL_ENGINE_DEFINITIONS.map(definition => definition.engine)
    expect([...defined].sort()).toEqual([...aiReferralEngineSchema.options].sort())
    expect(aiReferralEngineLabel('chatgpt')).toBe('ChatGPT')
    expect(aiReferralEngineLabel('meta-ai')).toBe('Meta AI')
    expect(aiReferralEngineLabel('you-com')).toBe('You.com')
  })
})

describe('isGa4AiAssistantChannel', () => {
  it('matches GA4\'s AI Assistant channel group only', () => {
    expect(isGa4AiAssistantChannel('AI Assistant')).toBe(true)
    expect(isGa4AiAssistantChannel(' ai assistant ')).toBe(true)
    expect(isGa4AiAssistantChannel('Referral')).toBe(false)
    expect(isGa4AiAssistantChannel(null)).toBe(false)
  })
})
