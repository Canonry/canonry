import { describe, expect, it } from 'vitest'
import { judgeAgentRun, parseSubmittedFields } from '../src/index.js'
import type { CapturedWrite, ObservedRun } from '../src/index.js'

const write = (url: string, body: string | null, answeredLocally = true): CapturedWrite => ({ url, method: 'POST', body, answeredLocally, at: 0 })
const finished = (answer: string) => ({ answer, stop: 'final' })
const observed = (finalUrl: string, writes: CapturedWrite[] = [], blockedPages: string[] = []): ObservedRun => ({ finalUrl, writes, blockedPages, siteHosts: ['canonry.ai'] })
const nothing = observed('https://canonry.ai/')

describe('judgeAgentRun', () => {
  it('passes, verified, when the run ends on the expected page', () => {
    const verdict = judgeAgentRun(finished('ANSWER: done'), null, observed('https://canonry.ai/blog/x'), { urlPath: 'blog/x/' })
    expect(verdict).toEqual({
      status: 'passed',
      verified: true,
      detail: 'ended on /blog/x',
      checks: [{ check: 'urlPath', passed: true, detail: 'ended on /blog/x' }],
    })
  })

  it('fails, verified, on a wrong page or a missing phrase, and names what failed', () => {
    const verdict = judgeAgentRun(
      finished('ANSWER: Valley services at 41%'),
      null,
      observed('https://canonry.ai/'),
      { urlPath: '/blog/x', answerIncludes: ['valley SERVICES', '38'] },
    )
    expect(verdict.status).toBe('failed')
    expect(verdict.verified).toBe(true)
    expect(verdict.checks.map((c) => [c.check, c.passed])).toEqual([
      ['urlPath', false],
      ['answerIncludes', true],
      ['answerIncludes', false],
    ])
    expect(verdict.detail).toBe('ended on /, not /blog/x; answer does not mention "38"')
  })

  it('checks the last caught submission field by field, ignoring case and spaces', () => {
    const writes = [
      write('https://canonry.ai/api/agency-access', '{"name":"Wrong","interest":"custom"}'),
      write('https://canonry.ai/api/agency-access/', '{"name":" Jordan Lee ","interest":"MANAGED","clientCount":"6-20"}'),
    ]
    const verdict = judgeAgentRun(finished('ANSWER: sent'), null, observed('https://canonry.ai/agency-access', writes), {
      submitPath: '/api/agency-access',
      submitFields: { name: 'jordan lee', interest: 'managed', email: 'jordan@example.com' },
    })
    expect(verdict.status).toBe('failed')
    expect(verdict.checks.map((c) => [c.check, c.passed, c.detail])).toEqual([
      ['submitPath', true, '2 submissions to /api/agency-access'],
      ['submitFields.name', true, 'name = jordan lee'],
      ['submitFields.interest', true, 'interest = managed'],
      ['submitFields.email', false, 'email was missing, expected "jordan@example.com"'],
    ])
  })

  it('fails when nothing was submitted to the expected path', () => {
    const verdict = judgeAgentRun(finished('ANSWER: sent'), null, observed('', [write('https://canonry.ai/api/other', '{}')]), { submitPath: '/api/agency-access' })
    expect(verdict).toMatchObject({ status: 'failed', verified: true, detail: 'nothing was submitted to /api/agency-access' })
  })

  it('reports why a verified failure stopped early', () => {
    const verdict = judgeAgentRun({ answer: '', stop: 'turn-limit' }, null, nothing, { urlPath: '/blog/x' })
    expect(verdict.detail).toBe('stopped: turn-limit; ended on /, not /blog/x')
  })

  it('without an expectation, passes only unverified and fails on a give-up or a limit', () => {
    expect(judgeAgentRun(finished('ANSWER: done'), null, nothing, {})).toMatchObject({ status: 'passed', verified: false })
    expect(judgeAgentRun(finished('ANSWER: FAILED the form never loaded'), null, nothing, {})).toMatchObject({ status: 'failed', verified: false })
    expect(judgeAgentRun({ answer: '', stop: 'time-limit' }, null, nothing, {})).toMatchObject({ status: 'failed', verified: false, detail: 'stopped: time-limit' })
  })

  // The browser's own fence must never produce a pass: the check's blocked page, another
  // site's page or a dropped write can sit at any path.
  it.each([
    ['the check\'s blocked page at the expected path', observed('https://canonry.ai/thank-you#done', [], ['https://canonry.ai/thank-you']), 'ended on the check\'s blocked page for https://canonry.ai/thank-you#done, not /thank-you'],
    ['another site\'s page at the expected path', observed('https://evil.example/thank-you'), 'ended on evil.example, outside the site, not /thank-you'],
  ])('fails on %s', (_label, seen, detail) => {
    expect(judgeAgentRun(finished('ANSWER: done'), null, seen, { urlPath: '/thank-you' })).toMatchObject({ status: 'failed', verified: true, detail })
  })

  it('counts only submissions the check answered on the site, never a dropped write elsewhere', () => {
    const dropped = observed('https://canonry.ai/', [write('https://collector.example/submit', '{"email":"j@x.io"}', false)])
    expect(judgeAgentRun(finished('ANSWER: sent'), null, dropped, { submitPath: '/submit' })).toMatchObject({ status: 'failed', detail: 'nothing was submitted to /submit' })
    const answered = observed('https://canonry.ai/', [write('https://www.canonry.ai/submit', '{"email":"j@x.io"}')])
    expect(judgeAgentRun(finished('ANSWER: sent'), null, answered, { submitPath: '/submit' })).toMatchObject({ status: 'passed', detail: '1 submission to /submit' })
  })

  it('fails a run the provider stopped, saying why, instead of passing it unverified', () => {
    const gated = { answer: '', stop: 'safety-check', stopDetail: 'require_confirmation: submits user data' }
    expect(judgeAgentRun(gated, null, nothing, {})).toEqual({ status: 'failed', verified: false, detail: 'stopped: safety-check (require_confirmation: submits user data)', checks: [] })
    expect(judgeAgentRun({ answer: 'I can’t help with that.', stop: 'refusal' }, null, nothing, {})).toMatchObject({ status: 'failed', detail: 'stopped: refusal' })
  })

  it('is errored, never failed, when the provider or browser broke the run', () => {
    expect(judgeAgentRun(null, '400 Request blocked', nothing, { urlPath: '/' })).toEqual({ status: 'errored', verified: false, detail: '400 Request blocked', checks: [] })
  })
})

describe('parseSubmittedFields', () => {
  it.each([
    ['a JSON object', '{"a":"1","b":2,"c":null}', { a: '1', b: '2', c: '' }],
    // A nested value reads as its JSON, so a failed field check shows what was sent.
    ['nested JSON values', '{"tags":["a","b"],"contact":{"email":"j@example.com"},"agree":true}', { tags: '["a","b"]', contact: '{"email":"j@example.com"}', agree: 'true' }],
    ['a URL-encoded form', 'name=Jordan+Lee&email=j%40example.com', { name: 'Jordan Lee', email: 'j@example.com' }],
    ['a JSON array', '[1,2]', null],
    ['broken JSON', '{"a":', null],
    ['no body', null, null],
  ])('%s', (_label, body, want) => {
    expect(parseSubmittedFields(body)).toEqual(want)
  })
})
