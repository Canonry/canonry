import { describe, expect, it } from 'vitest'
import { ProviderFailureBreaker } from '../src/provider-failure-breaker.js'

describe('ProviderFailureBreaker', () => {
  it('stops a provider after two failures in a row and keeps the error that stopped it', () => {
    const breaker = new ProviderFailureBreaker()
    breaker.failed('openrouter', 'HTTP 402: Insufficient credits')
    expect(breaker.stoppedBy('openrouter')).toBeUndefined()
    breaker.failed('openrouter', 'HTTP 402: Insufficient credits again')
    expect(breaker.stoppedBy('openrouter')).toBe('HTTP 402: Insufficient credits again')
    // A later failure does not replace the reason it stopped.
    breaker.failed('openrouter', 'HTTP 500')
    expect(breaker.stoppedBy('openrouter')).toBe('HTTP 402: Insufficient credits again')
  })

  it('a success between failures resets the streak', () => {
    const breaker = new ProviderFailureBreaker()
    breaker.failed('gemini', 'HTTP 503')
    breaker.succeeded('gemini')
    breaker.failed('gemini', 'HTTP 503')
    expect(breaker.stoppedBy('gemini')).toBeUndefined()
  })

  it('track counts a call\'s outcome before handing back its result or error', async () => {
    const breaker = new ProviderFailureBreaker()
    await expect(breaker.track('openrouter', async () => { throw new Error('HTTP 402: Insufficient credits') })).rejects.toThrow('HTTP 402')
    await expect(breaker.track('openrouter', async () => { throw new Error('HTTP 402: Insufficient credits') })).rejects.toThrow('HTTP 402')
    expect(breaker.stoppedBy('openrouter')).toBe('HTTP 402: Insufficient credits')
    const other = new ProviderFailureBreaker()
    await expect(other.track('gemini', async () => { throw new Error('HTTP 503') })).rejects.toThrow('HTTP 503')
    expect(await other.track('gemini', async () => 'answer')).toBe('answer')
    await expect(other.track('gemini', async () => { throw new Error('HTTP 503') })).rejects.toThrow('HTTP 503')
    // The success in between reset the streak.
    expect(other.stoppedBy('gemini')).toBeUndefined()
  })

  it('reports each provider\'s first reason, failed calls and whether it stopped, after every failure', () => {
    const reported: Array<Record<string, unknown>> = []
    const breaker = new ProviderFailureBreaker(2, failures => { reported.push(failures) })
    breaker.failed('openrouter', 'HTTP 402: Insufficient credits')
    breaker.succeeded('gemini')
    breaker.failed('openrouter', 'HTTP 402: still no credits')
    breaker.failed('gemini', 'HTTP 503')
    expect(reported).toEqual([
      { openrouter: { message: 'HTTP 402: Insufficient credits', failedQueries: 1, stopped: false } },
      { openrouter: { message: 'HTTP 402: Insufficient credits', failedQueries: 2, stopped: true } },
      {
        openrouter: { message: 'HTTP 402: Insufficient credits', failedQueries: 2, stopped: true },
        gemini: { message: 'HTTP 503', failedQueries: 1, stopped: false },
      },
    ])
  })

  it('tracks each provider apart', () => {
    const breaker = new ProviderFailureBreaker()
    breaker.failed('openrouter', 'down')
    breaker.failed('gemini', 'down')
    expect(breaker.stoppedBy('openrouter')).toBeUndefined()
    expect(breaker.stoppedBy('gemini')).toBeUndefined()
    breaker.failed('openrouter', 'down')
    expect(breaker.stoppedBy('openrouter')).toBe('down')
    expect(breaker.stoppedBy('gemini')).toBeUndefined()
  })
})
