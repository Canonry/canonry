import { describe, expect, it } from 'vitest'
import { agentBrowserRequestFromInput } from '../src/cli-commands/agent-browser.js'
import type { CliCommandInput } from '../src/cli-dispatch.js'

const input = (values: CliCommandInput['values']): CliCommandInput => ({ positionals: ['agent-browser', 'check', 'site'], values, format: 'text', dryRun: false })

describe('agent-browser check flags', () => {
  it('maps every flag onto the API request', () => {
    expect(agentBrowserRequestFromInput(input({
      task: 'Request a demo',
      property: ' harbor ',
      'start-url': 'https://example.com/contact',
      agent: ['openai,claude-a11y', 'gemini'],
      model: ['gemini=gemini-4-hydrogen'],
      runs: '3',
      'expect-url': '/thanks',
      'expect-answer': ['received', 'thank you'],
      'expect-submit': '/api/contact',
      'expect-field': ['email=jordan@example.com', 'note=a=b'],
      'max-minutes': '4',
      'max-turns': '40',
    }))).toEqual({
      task: 'Request a demo',
      property: 'harbor',
      startUrl: 'https://example.com/contact',
      agents: ['openai', 'claude-a11y', 'gemini'],
      models: { gemini: 'gemini-4-hydrogen' },
      repeats: 3,
      expect: {
        urlPath: '/thanks',
        answerIncludes: ['received', 'thank you'],
        submitPath: '/api/contact',
        // Only the first "=" splits, so a value may contain one.
        submitFields: { email: 'jordan@example.com', note: 'a=b' },
      },
      maxMinutesPerRun: 4,
      maxTurnsPerRun: 40,
    })
  })

  it('sends only the task when nothing else is given, so the API applies its defaults', () => {
    expect(agentBrowserRequestFromInput(input({ task: 'Find pricing' }))).toEqual({ task: 'Find pricing' })
  })

  it.each([
    ['no task', {}, '--task is required'],
    ['an unknown agent', { task: 'x', agent: ['bing'] }, 'unknown agent "bing"'],
    ['a field without its submit path', { task: 'x', 'expect-field': ['a=b'] }, '--expect-field needs --expect-submit'],
    ['a field with no "="', { task: 'x', 'expect-submit': '/a', 'expect-field': ['ab'] }, '--expect-field takes <name>=<value>'],
    ['a model for an unknown agent', { task: 'x', model: ['bing=m'] }, 'unknown agent "bing"'],
  ] as const)('refuses %s', (_label, values, message) => {
    expect(() => agentBrowserRequestFromInput(input(values as CliCommandInput['values']))).toThrow(message)
  })
})
