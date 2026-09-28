/** Source-free Node preload for the installed-package sentiment smoke, never product configuration. */
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const PROVIDER_URL = 'https://api.typesafe.ai/v1/systemone'

export function installSentimentSmokeGuard({ providerUrl, receiptPath, live = false, maxAttempts = 6, maxAssessments = 3, maxInputTokens = 150_000, transport = globalThis.fetch }) {
  if (providerUrl !== undefined) {
    const target = new URL(providerUrl)
    if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)) throw new Error('Smoke stub must use a loopback HTTP URL')
  }
  if (!providerUrl && !live) throw new Error('Smoke requires a loopback provider stub or explicit live mode')
  let attempts = 0
  let estimatedInputTokens = 0
  let reportedInputTokens = 0
  let unknownUsageAttempts = 0
  let stopped = false
  const assessments = new Set()
  const receipts = []
  const originalFetch = globalThis.fetch
  const write = receipt => {
    receipts.push(receipt)
    if (receiptPath) appendFileSync(receiptPath, JSON.stringify(receipt) + '\n', { mode: 0o600 })
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (request.url !== PROVIDER_URL) {
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('Non-smoke external request blocked')
      // Redirects are another outbound request; refuse them before they can escape loopback.
      return transport(new Request(request, { redirect: 'error' }))
    }
    if (stopped) throw new Error('Live sentiment smoke stopped after a provider contract failure')
    const body = await request.clone().text()
    const payload = JSON.parse(body)
    if (payload.model !== 'jev-1.13.0') throw new Error('Smoke evaluator must be pinned to jev-1.13.0')
    const fingerprint = createHash('sha256').update(JSON.stringify(payload.state)).digest('hex')
    const estimated = Buffer.byteLength(body, 'utf8') + 1024
    if (attempts >= maxAttempts || (assessments.size >= maxAssessments && !assessments.has(fingerprint)) || estimatedInputTokens + estimated > maxInputTokens) throw new Error('Sentiment smoke request or input-token budget exhausted')
    attempts++
    assessments.add(fingerprint)
    estimatedInputTokens += estimated
    const receipt = { attempt: attempts, assessment: fingerprint, requestedModel: payload.model, estimatedInputTokens: estimated, returnedModel: null, usage: { kind: 'unknown', inputTokens: null, outputTokens: null }, status: null }
    try {
      const response = await transport(new Request(providerUrl ?? PROVIDER_URL, { method: request.method, headers: request.headers, body, signal: request.signal, redirect: 'error' }))
      receipt.status = response.status
      let result
      try { result = await response.clone().json() } catch { result = null }
      receipt.returnedModel = typeof result?.model === 'string' ? result.model : null
      if (Number.isSafeInteger(result?.usage?.input_tokens) && result.usage.input_tokens >= 0 && Number.isSafeInteger(result?.usage?.output_tokens) && result.usage.output_tokens >= 0) {
        receipt.usage = { kind: 'reported', inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens }
        reportedInputTokens += result.usage.input_tokens
      } else unknownUsageAttempts++
      const validAnswers = result?.answers && Object.entries(payload.questions).every(([id, question]) => {
        const answer = result.answers[id]
        if (answer?.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice) || !answer.probabilities) return false
        const keys = Object.keys(question.criteria)
        if (Object.keys(answer.probabilities).length !== keys.length || !keys.every(key => typeof answer.probabilities[key] === 'number' && Number.isFinite(answer.probabilities[key]) && answer.probabilities[key] >= 0 && answer.probabilities[key] <= 1)) return false
        if (Math.abs(Object.values(answer.probabilities).reduce((total, value) => total + value, 0) - 1) > 0.02) return false
        return answer.confidence === undefined || (typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1)
      })
      if (response.status === 401 || response.status === 403 || (response.ok && (receipt.returnedModel !== payload.model || !validAnswers || receipt.usage.kind !== 'reported')) || reportedInputTokens > maxInputTokens) stopped = true
      write(receipt)
      return response
    } catch (error) {
      unknownUsageAttempts++
      write(receipt)
      throw error
    }
  }
  return {
    snapshot: () => ({ attempts, assessments: assessments.size, estimatedInputTokens, reportedInputTokens, unknownUsageAttempts, stopped, receipts: structuredClone(receipts) }),
    restore: () => { globalThis.fetch = originalFetch },
  }
}

if (process.env.CANONRY_SENTIMENT_SMOKE_GUARD === '1') {
  installSentimentSmokeGuard({ providerUrl: process.env.CANONRY_SENTIMENT_SMOKE_PROVIDER_URL, receiptPath: process.env.CANONRY_SENTIMENT_SMOKE_RECEIPTS, live: process.env.CANONRY_SENTIMENT_SMOKE_LIVE === '1' })
}
