import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverEvalWithClient } from '../src/commands/discover-eval.js'
import {
  DISCOVERY_EVAL_PANEL,
  compareToBaseline,
  scoreSession,
  type DiscoveryEvalScorecard,
} from '../src/discovery-eval.js'

function sessionFixture(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    projectId: 'p1',
    status: 'completed',
    seedCountRaw: 30,
    seedCount: 2,
    canonicalCount: 17,
    seedBrandFilteredCount: 0,
    seedFromAnswerCount: 30,
    seedFromGroundingCount: 0,
    dedupBandPairFraction: 0.35,
    probeCount: 2,
    warning: null,
    createdAt: '2026-07-02T00:00:00.000Z',
    startedAt: '2026-07-02T00:00:00.000Z',
    finishedAt: '2026-07-02T00:01:30.000Z',
    ...over,
  } as never
}

describe('scoreSession', () => {
  it('computes the scorecard from the honest pre-truncation canonical count', () => {
    const card = scoreSession('b2b-saas', sessionFixture())
    expect(card).toMatchObject({
      shape: 'b2b-saas',
      seedCountRaw: 30,
      canonicalCount: 17,
      brandShare: 0,
      groundingShare: 0,
      bandPairFraction: 0.35,
      warning: null,
      durationSeconds: 90,
    })
    expect(card.retention).toBeCloseTo(17 / 30, 5)
  })

  it('computes brand share against the pre-filter total', () => {
    const card = scoreSession('x', sessionFixture({ seedBrandFilteredCount: 10, seedCountRaw: 30 }))
    expect(card.brandShare).toBeCloseTo(10 / 40, 5)
  })

  it('falls back to the truncated seedCount ONLY when canonicalCount is null (legacy engine), and flags it', () => {
    const card = scoreSession('x', sessionFixture({ canonicalCount: null, seedCount: 2 }))
    expect(card.canonicalCount).toBe(2)
    expect(card.canonicalCountTruncated).toBe(true)
  })
})

describe('compareToBaseline', () => {
  const baselineCard: DiscoveryEvalScorecard = {
    shape: 'b2b-saas',
    seedCountRaw: 30,
    canonicalCount: 20,
    canonicalCountTruncated: false,
    retention: 20 / 30,
    brandShare: 0,
    groundingShare: 0,
    bandPairFraction: 0.3,
    probeCount: 2,
    warning: null,
    durationSeconds: 60,
  }
  const baseline = { capturedAt: 'x', scorecards: [baselineCard] }

  it('passes when metrics hold within bands', () => {
    const verdict = compareToBaseline([{ ...baselineCard, canonicalCount: 18, retention: 18 / 30 }], baseline)
    expect(verdict.pass).toBe(true)
    expect(verdict.regressions).toEqual([])
  })

  it('fails on a canonical-count collapse beyond the band', () => {
    const verdict = compareToBaseline([{ ...baselineCard, canonicalCount: 9, retention: 9 / 30 }], baseline)
    expect(verdict.pass).toBe(false)
    expect(verdict.regressions.join(' ')).toMatch(/canonicalCount/)
  })

  it('fails when canonicals drop below the absolute platform floor regardless of baseline', () => {
    const weakBaseline = { capturedAt: 'x', scorecards: [{ ...baselineCard, canonicalCount: 9, retention: 0.3 }] }
    const verdict = compareToBaseline([{ ...baselineCard, canonicalCount: 7, retention: 7 / 30 }], weakBaseline)
    expect(verdict.pass).toBe(false)
    expect(verdict.regressions.join(' ')).toMatch(/floor/)
  })

  it('fails on brand-share leakage and on a collapse warning', () => {
    const brandy = compareToBaseline([{ ...baselineCard, brandShare: 0.3 }], baseline)
    expect(brandy.pass).toBe(false)
    const warned = compareToBaseline([{ ...baselineCard, warning: 'Seed dedup collapsed 30 raw candidates' }], baseline)
    expect(warned.pass).toBe(false)
  })

  it('fails when a baseline shape is missing from the run, and reports new shapes without failing', () => {
    const verdict = compareToBaseline([], baseline)
    expect(verdict.pass).toBe(false)
    expect(verdict.regressions.join(' ')).toMatch(/missing/)
    const extra = compareToBaseline(
      [baselineCard, { ...baselineCard, shape: 'brand-new-shape' }],
      baseline,
    )
    expect(extra.pass).toBe(true)
    expect(extra.notes.join(' ')).toMatch(/brand-new-shape/)
  })

  it('a slower run within 2x+30s passes; beyond it fails', () => {
    expect(compareToBaseline([{ ...baselineCard, durationSeconds: 140 }], baseline).pass).toBe(true)
    expect(compareToBaseline([{ ...baselineCard, durationSeconds: 200 }], baseline).pass).toBe(false)
  })
})

describe('DISCOVERY_EVAL_PANEL', () => {
  it('spans the five failure-mode shapes with fictional businesses', () => {
    expect(DISCOVERY_EVAL_PANEL.map((s) => s.slug)).toEqual([
      'eval-local-single-intent',
      'eval-local-multi-intent',
      'eval-b2b-saas',
      'eval-national-ecommerce',
      'eval-problem-heavy-consumer',
    ])
    for (const shape of DISCOVERY_EVAL_PANEL) {
      expect(shape.icp.length).toBeGreaterThan(10)
      expect(shape.buyer.length).toBeGreaterThan(10)
    }
  })
})

describe('discoverEvalWithClient (stubbed client, no provider calls)', () => {
  function stubClient(sessionOver: Record<string, unknown> = {}) {
    const calls: Record<string, unknown[]> = { put: [], run: [] }
    let counter = 0
    const client = {
      async putProject(name: string, body: object) {
        calls.put.push({ name, body })
        return {}
      },
      async triggerDiscoveryRun(name: string, body?: object) {
        counter++
        calls.run.push({ name, body })
        return { sessionId: `s-${counter}` }
      },
      async listDiscoverySessions(_name: string) {
        return [sessionFixture({ id: `s-${counter}`, ...sessionOver })] as never
      },
    }
    return { client, calls }
  }

  it('runs the panel, writes a baseline with --update-baseline, then passes against it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-eval-test-'))
    const baseline = path.join(dir, 'baseline.json')
    try {
      const { client, calls } = stubClient()
      await discoverEvalWithClient(client as never, {
        baseline,
        updateBaseline: true,
        shapes: ['eval-b2b-saas', 'eval-national-ecommerce'],
        pollIntervalMs: 1,
        now: () => 0,
      })
      expect(calls.put).toHaveLength(2)
      expect(calls.run).toHaveLength(2)
      const written = JSON.parse(fs.readFileSync(baseline, 'utf8'))
      expect(written.scorecards).toHaveLength(2)

      // Second run compares against the just-written baseline and passes.
      const second = stubClient()
      await expect(
        discoverEvalWithClient(second.client as never, {
          baseline,
          shapes: ['eval-b2b-saas', 'eval-national-ecommerce'],
          pollIntervalMs: 1,
          now: () => 0,
        }),
      ).resolves.toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits with EVAL_REGRESSION when a shape collapses below the bands', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-eval-test-'))
    const baseline = path.join(dir, 'baseline.json')
    try {
      const good = stubClient()
      await discoverEvalWithClient(good.client as never, {
        baseline, updateBaseline: true, shapes: ['eval-b2b-saas'], pollIntervalMs: 1, now: () => 0,
      })
      const collapsed = stubClient({ canonicalCount: 3, seedCount: 3 })
      await expect(
        discoverEvalWithClient(collapsed.client as never, {
          baseline, shapes: ['eval-b2b-saas'], pollIntervalMs: 1, now: () => 0,
        }),
      ).rejects.toMatchObject({ code: 'EVAL_REGRESSION' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sends buyer, budget knobs, and optional seed providers on every run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-eval-test-'))
    try {
      const { client, calls } = stubClient()
      await discoverEvalWithClient(client as never, {
        baseline: path.join(dir, 'b.json'), updateBaseline: true,
        shapes: ['eval-b2b-saas'], seedProviders: ['gemini', 'openai'],
        maxProbes: 3, probeConcurrency: 2, pollIntervalMs: 1, now: () => 0,
      })
      const run = calls.run[0] as { body: Record<string, unknown> }
      expect(run.body.buyerDescription).toMatch(/solar sales managers/)
      expect(run.body.maxProbes).toBe(3)
      expect(run.body.seedProviders).toEqual(['gemini', 'openai'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails fast with a clear error when no baseline exists and --update-baseline was not passed', async () => {
    const { client } = stubClient()
    await expect(
      discoverEvalWithClient(client as never, {
        baseline: '/nonexistent/dir/baseline.json', shapes: ['eval-b2b-saas'], pollIntervalMs: 1, now: () => 0,
      }),
    ).rejects.toMatchObject({ code: 'EVAL_NO_BASELINE' })
  })
})
