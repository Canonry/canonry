/**
 * Screen-reader-only data tables must hide through a wrapper, never through
 * `sr-only` on the `<table>` itself.
 *
 * `sr-only` shrinks a box to 1px with `overflow: hidden`, but a table box is
 * never narrower than its content, so the width does not apply. The utility
 * also sets `white-space: nowrap` and `position: absolute`, so every row lays
 * out on one line and nothing clips it. The Simple trend chart's data table did
 * exactly that: at 375px it measured 1,777px wide and made the whole AI
 * Visibility overview scroll sideways to 1,812px. Wrapping it in
 * `<div className="sr-only">` clips the table inside a real 1px box, which is
 * what the Advanced report trend already did.
 *
 * jsdom does not lay out, so the width itself cannot be asserted here. The
 * component test pins the fixed structure, and the source scan fails on the
 * next table that repeats the mistake anywhere in the dashboard.
 */
import React from 'react'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

afterEach(cleanup)

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  const nul = () => null
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: passthrough,
    CartesianGrid: nul,
    XAxis: nul,
    YAxis: nul,
    Tooltip: nul,
    Legend: nul,
    Line: nul,
    Area: nul,
    Bar: nul,
    BarChart: passthrough,
    Cell: nul,
    ReferenceArea: nul,
    ReferenceLine: nul,
  }
})

import { VisibilityTrendSection } from '../src/components/project/VisibilityTrendSection.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

function provider(citationRate: number, mentionRate: number) {
  return { citationRate, cited: 1, total: 4, mentionRate, mentionedCount: 2 }
}

const BUCKETS = [
  {
    startDate: '2026-04-01T00:00:00.000Z', endDate: '2026-04-08T00:00:00.000Z',
    dataStartDate: '2026-04-03T14:20:00.000Z', dataEndDate: '2026-04-03T14:20:00.000Z', sweepCount: 1,
    citationRate: 0.25, cited: 1, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
    mentionShare: { scope: 'non-brand', rate: 0.25, projectMentionSnapshots: 1, competitorMentionSnapshots: 3 },
    byProvider: { gemini: provider(0.25, 0.5), openai: provider(0.5, 0.25) },
    modelEvidenceByProvider: { gemini: { status: 'known', model: 'gemini-2.0-flash' }, openai: { status: 'unknown' } },
  },
  {
    startDate: '2026-04-08T00:00:00.000Z', endDate: '2026-04-15T00:00:00.000Z',
    dataStartDate: '2026-04-11T08:05:00.000Z', dataEndDate: '2026-04-11T08:05:00.000Z', sweepCount: 1,
    citationRate: 0.75, cited: 3, total: 4, queryCount: 4, mentionRate: 0.5, mentionedCount: 2,
    mentionShare: { scope: 'non-brand', rate: 0.75, projectMentionSnapshots: 3, competitorMentionSnapshots: 1 },
    byProvider: { gemini: provider(0.75, 0.5) },
    modelEvidenceByProvider: { gemini: { status: 'known', model: 'gemini-2.0-flash' } },
  },
]

function metricsDto() {
  return {
    window: 'all',
    mentionShareScope: 'non-brand',
    buckets: BUCKETS,
    overall: provider(0.5, 0.5),
    byProvider: { gemini: provider(0.5, 0.5) },
    trend: 'improving',
    mentionTrend: 'stable',
    queryChanges: [],
    modelAttribution: {},
  }
}

test('the Simple trend data table hides inside an sr-only wrapper, not through sr-only on the table', async () => {
  const restore = mockFetch((url) => {
    if (url.split('?')[0]!.endsWith('/projects/test-project/analytics/metrics')) return jsonResponse(metricsDto())
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restore)

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <VisibilityTrendSection projectName="test-project" competitorDomains={[]} />
    </QueryClientProvider>,
  )

  const table = (await screen.findByText('Mentioned trend data')).closest('table')!
  expect(table).toBeTruthy()
  expect(table.classList.contains('sr-only')).toBe(false)
  expect(table.parentElement!.tagName).toBe('DIV')
  expect(table.parentElement!.classList.contains('sr-only')).toBe(true)
  // The data is still there for assistive technology: one row per bucket.
  expect(table.querySelectorAll('tbody tr')).toHaveLength(BUCKETS.length)
})

/**
 * Every `<table ...>` opening tag whose className names the `sr-only` class, as
 * 1-based line numbers. The class must stand alone: `\b` would also match inside
 * Tailwind's `not-sr-only`, which un-hides an element and is not the bug.
 */
function srOnlyTableLines(source: string): number[] {
  const srOnly = String.raw`(?<![\w-])sr-only(?![\w-])`
  const pattern = new RegExp(String.raw`<table\s[^>]*?\bclassName=(?:"[^"]*${srOnly}[^"]*"|'[^']*${srOnly}[^']*'|\{[^}]*${srOnly}[^}]*\})`, 'g')
  return [...source.matchAll(pattern)].map(match => source.slice(0, match.index).split('\n').length)
}

test('the source scan recognizes the pattern it guards against', () => {
  expect(srOnlyTableLines('<table className="sr-only">')).toEqual([1])
  expect(srOnlyTableLines('x\n<table\n  aria-label="t"\n  className={cn(\'sr-only\', extra)}\n>')).toEqual([2])
  expect(srOnlyTableLines('<div className="sr-only"><table className="evidence-table">')).toEqual([])
  expect(srOnlyTableLines('<table className="not-sr-only-ish">')).toEqual([])
})

const SRC_DIR = resolve(import.meta.dirname, '../src')

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(full)
    return entry.name.endsWith('.tsx') ? [full] : []
  })
}

test('no dashboard table is hidden with sr-only on the table element', () => {
  const offenders = tsxFiles(SRC_DIR).flatMap(file =>
    srOnlyTableLines(readFileSync(file, 'utf8')).map(line => `${relative(SRC_DIR, file)}:${line}`),
  )
  expect(offenders).toEqual([])
})
