import { describe, expect, it } from 'vitest'
import {
  buildProviderTrends,
  providerKey,
  type ProviderTrendRun,
  type ProviderTrendSnapshot,
} from '../src/provider-trends.js'

function snap(
  provider: string,
  model: string | null,
  queryId: string,
  citationState: 'cited' | 'not-cited' = 'not-cited',
): ProviderTrendSnapshot {
  return { provider, model, queryId, citationState }
}

function run(id: string, createdAt: string): ProviderTrendRun {
  return { id, createdAt }
}

describe('buildProviderTrends', () => {
  it('returns empty map when no runs', () => {
    const result = buildProviderTrends([], new Map())
    expect(result.size).toBe(0)
  })

  it('computes per-run citation rate per (provider, model) key', () => {
    const runs = [run('r1', '2026-05-10'), run('r2', '2026-05-11')]
    const snapshotsByRun = new Map([
      ['r1', [
        snap('gemini', 'flash', 'q1', 'cited'),
        snap('gemini', 'flash', 'q2', 'not-cited'),
        snap('openai', 'gpt-5', 'q1', 'cited'),
      ]],
      ['r2', [
        snap('gemini', 'flash', 'q1', 'cited'),
        snap('gemini', 'flash', 'q2', 'cited'),
        snap('openai', 'gpt-5', 'q1', 'not-cited'),
      ]],
    ])
    const result = buildProviderTrends(runs, snapshotsByRun)
    const geminiKey = providerKey('gemini', 'flash')
    const openaiKey = providerKey('openai', 'gpt-5')

    expect(result.get(geminiKey)?.map(p => p.rate)).toEqual([50, 100])
    expect(result.get(openaiKey)?.map(p => p.rate)).toEqual([100, 0])
  })

  it('sorts oldest-first so sparklines read left-to-right', () => {
    const runs = [run('r2', '2026-05-11'), run('r1', '2026-05-10')]
    const snapshotsByRun = new Map([
      ['r1', [snap('gemini', null, 'q1', 'cited')]],
      ['r2', [snap('gemini', null, 'q1', 'not-cited')]],
    ])
    const result = buildProviderTrends(runs, snapshotsByRun)
    const points = result.get(providerKey('gemini', null))!
    expect(points.map(p => p.createdAt)).toEqual(['2026-05-10', '2026-05-11'])
    expect(points.map(p => p.rate)).toEqual([100, 0])
  })

  it('respects the limit (most-recent N runs)', () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      run(`r${i}`, `2026-05-${String(i + 1).padStart(2, '0')}`),
    )
    const snapshotsByRun = new Map(
      runs.map(r => [r.id, [snap('gemini', null, 'q1', 'cited')]]),
    )
    const result = buildProviderTrends(runs, snapshotsByRun, 5)
    expect(result.get(providerKey('gemini', null))).toHaveLength(5)
  })

  it('emits a 0-rate point when a (provider, model) has no snapshots in a run', () => {
    const runs = [run('r1', '2026-05-10'), run('r2', '2026-05-11')]
    const snapshotsByRun = new Map([
      ['r1', [snap('gemini', null, 'q1', 'cited')]],
      // r2 has no gemini snapshots
      ['r2', [snap('openai', null, 'q1', 'cited')]],
    ])
    const result = buildProviderTrends(runs, snapshotsByRun)
    expect(result.get(providerKey('gemini', null))?.map(p => p.rate)).toEqual([100, 0])
    expect(result.get(providerKey('openai', null))?.map(p => p.rate)).toEqual([0, 100])
  })

  it('keeps unknown model as the "unknown" key', () => {
    const result = buildProviderTrends(
      [run('r1', '2026-05-10')],
      new Map([['r1', [snap('gemini', null, 'q1', 'cited')]]]),
    )
    expect([...result.keys()]).toEqual(['gemini::unknown'])
  })
})
