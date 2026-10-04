import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { USAGE_TELEMETRY_HEADERS, type FeedbackSubmission } from '@ainyc/canonry-contracts'
import { feedbackRoutes, type FeedbackRequestContext, type FeedbackRoutesOptions } from '../src/feedback.js'

async function buildApp(submitFeedback?: FeedbackRoutesOptions['submitFeedback']) {
  const app = Fastify()
  await app.register(feedbackRoutes, { submitFeedback })
  await app.ready()
  return app
}

describe('feedback route', () => {
  it('forwards a valid submission with the caller labels and answers 202', async () => {
    const seen: Array<{ submission: FeedbackSubmission; context: FeedbackRequestContext }> = []
    const app = await buildApp(async (submission, context) => {
      seen.push({ submission, context })
      return { accepted: true, id: 'fb-1' }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/feedback',
      headers: {
        'user-agent': 'canonry-mcp',
        [USAGE_TELEMETRY_HEADERS.surface]: 'mcp-stdio',
        [USAGE_TELEMETRY_HEADERS.agent]: 'claude',
      },
      payload: { kind: 'struggle', summary: '  sweep fails on free Gemini key ', errorCode: 'RATE_LIMITED' },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: true, id: 'fb-1' })
    expect(seen).toEqual([{
      submission: { kind: 'struggle', summary: 'sweep fails on free Gemini key', errorCode: 'RATE_LIMITED' },
      context: { userAgent: 'canonry-mcp', surface: 'mcp-stdio', agent: 'claude', mcpClient: undefined },
    }])
  })

  it('rejects an invalid submission before forwarding anything', async () => {
    let called = false
    const app = await buildApp(async () => { called = true; return { accepted: true, id: 'x' } })
    const response = await app.inject({ method: 'POST', url: '/feedback', payload: { kind: 'rant', summary: '' } })
    expect(response.statusCode).toBe(400)
    expect(called).toBe(false)
  })

  it('answers 501 where feedback is not wired', async () => {
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: '/feedback', payload: { kind: 'other', summary: 'hello' } })
    expect(response.statusCode).toBe(501)
  })
})
