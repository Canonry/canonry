import { describe, expect, it } from 'vitest'
import type { Api, Model } from '@mariozechner/pi-ai'
import {
  splitAeroAnthropicSystemCachePayload,
  splitAeroHydratedSystemPrompt,
} from '../src/agent/prompt-cache.js'

const anthropicModel = {
  id: 'claude-opus-4-7',
  name: 'Claude Opus 4.7',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 32000,
} as Model<Api>

const openAiModel = {
  ...anthropicModel,
  api: 'openai-responses',
  provider: 'openai',
} as Model<Api>

describe('Aero Anthropic prompt cache payload split', () => {
  it('splits hydrated memory out of the stable system prompt', () => {
    const prompt = 'You are Aero.\n\n---\n\n<memory>\n- [user] goal: ads\n</memory>'

    expect(splitAeroHydratedSystemPrompt(prompt)).toEqual({
      basePrompt: 'You are Aero.',
      memoryBlock: '<memory>\n- [user] goal: ads\n</memory>',
    })
  })

  it('keeps cache_control on the stable system block and removes it from dynamic memory', () => {
    const payload = {
      model: 'claude-opus-4-7',
      system: [
        {
          type: 'text',
          text: 'You are Aero.\n\n---\n\n<memory>\n- [user] goal: ads\n</memory>',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: 'status' }],
    }

    const out = splitAeroAnthropicSystemCachePayload(payload, anthropicModel)
    const changed = out as { system: Array<Record<string, unknown>> }

    expect(changed.system).toHaveLength(2)
    expect(changed.system[0]).toMatchObject({
      type: 'text',
      text: 'You are Aero.',
      cache_control: { type: 'ephemeral' },
    })
    expect(changed.system[1]).toMatchObject({
      type: 'text',
      text: '<memory>\n- [user] goal: ads\n</memory>',
    })
    expect(changed.system[1].cache_control).toBeUndefined()
  })

  it('leaves non-Anthropic payloads unchanged', () => {
    const payload = {
      system: [
        {
          type: 'text',
          text: 'You are Aero.\n\n---\n\n<memory>\n- [user] goal: ads\n</memory>',
          cache_control: { type: 'ephemeral' },
        },
      ],
    }

    expect(splitAeroAnthropicSystemCachePayload(payload, openAiModel)).toBeUndefined()
  })
})
