import { describe, it, expect } from 'vitest'
import { extractDomainMentions, normalizeResult, extractServedModel } from '../src/normalize.js'
import type { LocalRawResult } from '../src/types.js'

describe('normalizeResult', () => {
  it('extracts domain mentions from answer text', () => {
    const text = 'Check out example.com and https://another-site.org/path. Also sub.domain.co.uk.'
    const domains = extractDomainMentions(text)
    expect(domains).toContain('example.com')
    expect(domains).toContain('another-site.org')
    expect(domains).toContain('sub.domain.co.uk')
    expect(domains).not.toContain('www.example.com')
  })

  it('normalizes a full local result', () => {
    const raw: LocalRawResult = {
      provider: 'local',
      model: 'llama3',
      rawResponse: {
        choices: [
          {
            message: {
              content: 'The domain is canonry.io'
            }
          }
        ]
      },
      groundingSources: [],
      searchQueries: []
    }
    const normalized = normalizeResult(raw)
    expect(normalized.answerText).toBe('The domain is canonry.io')
    expect(normalized.citedDomains).toContain('canonry.io')
  })
})

describe('extractServedModel', () => {
  // Local servers speak the OpenAI ChatCompletion shape and routinely echo back a more
  // specific tag than the one requested (e.g. `llama3` -> `llama3:8b-instruct-q4_0`).
  // Constructed, not captured — no local server was called for this change.
  const localResponse: Record<string, unknown> = {
    id: 'chatcmpl-local-1',
    object: 'chat.completion',
    model: 'llama3:8b-instruct-q4_0',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Answer.' } },
    ],
  }

  it('captures the model the local server reported serving, not the configured alias', () => {
    const configuredModel = 'llama3'
    const servedModel = extractServedModel(localResponse)
    expect(servedModel).toBe('llama3:8b-instruct-q4_0')
    expect(servedModel).not.toBe(configuredModel)
  })

  it('returns undefined when the response carries no model field', () => {
    const { model: _model, ...withoutModel } = localResponse
    const servedModel = extractServedModel(withoutModel)
    expect(servedModel).toBeUndefined()
    expect(servedModel).not.toBe('')
    expect(servedModel).not.toBe('llama3')
  })

  it('returns undefined for a whitespace-only model field', () => {
    expect(extractServedModel({ ...localResponse, model: '  ' })).toBeUndefined()
  })
})
