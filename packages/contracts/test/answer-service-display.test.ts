import { describe, expect, it } from 'vitest'
import { formatAnswerServiceRouteLabel } from '../src/answer-service.js'

describe('formatAnswerServiceRouteLabel', () => {
  it.each([
    ['cloro:chatgpt', 'ChatGPT via Cloro'],
    ['cloro:aimode', 'Google AI Mode via Cloro'],
    ['cloro:bing-aimode', 'Bing AI Mode via Cloro'],
    ['exa:standard', 'Standard via Exa'],
    ['parallel:medium', 'Medium via Parallel'],
    ['new-service:quick-answer', 'Quick Answer via New Service'],
  ])('labels the stored route %s without administrative settings', (route, label) => {
    expect(formatAnswerServiceRouteLabel(route)).toBe(label)
  })

  it('uses the supplied catalog names for a service and its profile', () => {
    const catalog = [
      { name: 'parallel', displayName: 'Parallel', profiles: [{ id: 'medium', displayName: 'Medium effort' }] },
      { name: 'cloro', displayName: 'cloro', profiles: [{ id: 'chatgpt', displayName: 'ChatGPT' }] },
      { name: 'cased', displayName: 'iCased' },
      { name: 'cased:medium', profiles: [{ id: 'medium', displayName: 'Medium effort' }] },
    ]
    expect(formatAnswerServiceRouteLabel('parallel:medium', catalog)).toBe('Medium effort via Parallel')
    expect(formatAnswerServiceRouteLabel('cloro:chatgpt', catalog)).toBe('ChatGPT via Cloro')
    expect(formatAnswerServiceRouteLabel('cased:medium', catalog)).toBe('Medium effort via iCased')
  })

  it.each(['gemini', 'cloro', 'cdp:chatgpt', 'openrouter:vendor/model', 'service:', 'service:bad:profile'])(
    'leaves %s to its existing formatter',
    route => expect(formatAnswerServiceRouteLabel(route)).toBeUndefined(),
  )
})
