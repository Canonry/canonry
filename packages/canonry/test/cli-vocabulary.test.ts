import { describe, it, expect } from 'vitest'
import type { RunDetailDto } from '@ainyc/canonry-contracts'
import { printRunDetail } from '../src/commands/run.js'
import { listEvents } from '../src/commands/notify.js'

function captureStdout(fn: () => void): string {
  const orig = console.log
  let buf = ''
  console.log = (...args: unknown[]) => {
    buf += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'
  }
  try {
    fn()
  } finally {
    console.log = orig
  }
  return buf
}

function makeRun(overrides: Partial<RunDetailDto['snapshots'] extends Array<infer S> | undefined ? S : never>[] = []): RunDetailDto {
  return {
    id: 'run-1',
    projectId: 'proj-1',
    status: 'completed',
    kind: 'answer-visibility',
    trigger: 'manual',
    createdAt: new Date('2026-01-01').toISOString(),
    snapshots: overrides.map((o, i) => ({
      id: `snap-${i}`,
      runId: 'run-1',
      keywordId: `kw-${i}`,
      keyword: o.keyword ?? `keyword ${i}`,
      provider: o.provider ?? 'gemini',
      citationState: o.citationState ?? 'cited',
      answerMentioned: o.answerMentioned,
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      matchedTerms: [],
      groundingSources: [],
      searchQueries: [],
      createdAt: new Date('2026-01-01').toISOString(),
      ...o,
    })) as RunDetailDto['snapshots'],
  } as RunDetailDto
}

describe('CLI canonical vocabulary', () => {
  describe('printRunDetail snapshot rendering', () => {
    it('renders both citation and mention signals as a two-glyph cell', () => {
      const run = makeRun([
        { keyword: 'kw-cited-and-mentioned', citationState: 'cited', answerMentioned: true },
        { keyword: 'kw-cited-only', citationState: 'cited', answerMentioned: false },
        { keyword: 'kw-mentioned-only', citationState: 'not-cited', answerMentioned: true },
        { keyword: 'kw-neither', citationState: 'not-cited', answerMentioned: false },
      ])
      const out = captureStdout(() => printRunDetail(run))

      expect(out).toContain('[CM]  gemini  kw-cited-and-mentioned')
      expect(out).toContain('[Cm]  gemini  kw-cited-only')
      expect(out).toContain('[cM]  gemini  kw-mentioned-only')
      expect(out).toContain('[cm]  gemini  kw-neither')
    })

    it('renders the dash glyph for mention when answerMentioned is undefined', () => {
      const run = makeRun([
        { keyword: 'kw-no-mention-data', citationState: 'cited', answerMentioned: undefined },
      ])
      const out = captureStdout(() => printRunDetail(run))
      expect(out).toContain('[C–]  gemini  kw-no-mention-data')
    })

    it('prints a legend that disambiguates citation and mention glyphs', () => {
      const run = makeRun([{ citationState: 'cited', answerMentioned: true }])
      const out = captureStdout(() => printRunDetail(run))
      expect(out).toContain('cell = [citation][mention]')
      expect(out).toContain('C=cited c=not')
      expect(out).toContain('M=mentioned m=not')
    })

    it('never uses legacy "visible" / "not-vis" labels for snapshots', () => {
      const run = makeRun([
        { citationState: 'cited', answerMentioned: true },
        { citationState: 'not-cited', answerMentioned: false },
      ])
      const out = captureStdout(() => printRunDetail(run))
      // Snapshot rows must not carry the ambiguous legacy labels.
      // Line-by-line check so we don't accidentally match the legend.
      const snapshotLines = out.split('\n').filter(line => line.includes('gemini  '))
      for (const line of snapshotLines) {
        expect(line).not.toContain('visible')
        expect(line).not.toContain('not-vis')
      }
    })
  })

  describe('notification event descriptions', () => {
    it('describes run.completed and run.failed as AEO sweeps, not "visibility runs"', () => {
      const out = captureStdout(() => listEvents())
      expect(out).toContain('run.completed')
      expect(out).toContain('AEO sweep completed')
      expect(out).toContain('run.failed')
      expect(out).toContain('AEO sweep failed')
      expect(out).not.toContain('visibility run')
    })
  })
})
