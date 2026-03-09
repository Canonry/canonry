import type {
  GeminiConfig,
  GeminiHealthcheckResult,
  GeminiNormalizedResult,
  GeminiRawResult,
  GeminiTrackedQueryInput,
} from './types.js'

export function validateConfig(config: GeminiConfig): GeminiHealthcheckResult {
  return {
    ok: config.apiKey.length > 0,
    provider: 'gemini',
    message: config.apiKey.length > 0 ? 'phase-1 placeholder config accepted' : 'missing api key',
  }
}

export async function healthcheck(config: GeminiConfig): Promise<GeminiHealthcheckResult> {
  return validateConfig(config)
}

export async function executeTrackedQuery(_input: GeminiTrackedQueryInput): Promise<GeminiRawResult> {
  return {
    provider: 'gemini',
    rawResponse: {
      status: 'not-implemented',
      phase: '1',
    },
  }
}

export function normalizeResult(_raw: GeminiRawResult): GeminiNormalizedResult {
  return {
    provider: 'gemini',
    answerText: 'Phase 1 placeholder',
    citedDomains: [],
  }
}
