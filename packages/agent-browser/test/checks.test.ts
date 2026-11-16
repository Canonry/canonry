import { describe, expect, it } from 'vitest'
import { judgeAgentRun, parseSubmittedFields } from '../src/index.js'
import type { CapturedWrite } from '../src/index.js'

const write = (url: string, body: string | null): CapturedWrite => ({ url, method: 'POST', body, answeredLocally: true, at: 0 })
const finished = (answer: string) => ({ answer, stop: 'final' })
const nothing = { finalUrl: 'https://canonry.ai/', writes: [] as CapturedWrite[] }

describe('judgeAgentRun', () => {
  it('passes, verified, when the run ends on the expected page', () => {
    const verdict = judgeAgentRun(finished('ANSWER: done'), null, { finalUrl: 'https://canonry.ai/blog/x', writes: [] }, { urlPath: 'blog/x/' })
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
      { finalUrl: 'https://canonry.ai/', writes: [] },
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
    const verdict = judgeAgentRun(finished('ANSWER: sent'), null, { finalUrl: 'https://canonry.ai/agency-access', writes }, {
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
    const verdict = judgeAgentRun(finished('ANSWER: sent'), null, { finalUrl: '', writes: [write('https://canonry.ai/api/other', '{}')] }, { submitPath: '/api/agency-access' })
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
