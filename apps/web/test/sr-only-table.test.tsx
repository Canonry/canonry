/**
 * Screen-reader-only data tables must hide through a wrapper, never through
 * `sr-only` on anything that lays out as a table.
 *
 * `sr-only` shrinks a box to 1px with `overflow: hidden`, but a table box is
 * never narrower than its content, so the width does not apply. The utility
 * also sets `white-space: nowrap` and `position: absolute`, so every row lays
 * out on one line and nothing clips it. The Simple trend chart's data table did
 * exactly that: at 375px it measured 1,777px wide and made the whole AI
 * Visibility overview scroll sideways to 1,812px. Wrapping it in
 * `<div className="sr-only">` clips the table inside a real 1px box, which is
 * what the Advanced report trend already did. An element given Tailwind's
 * `table` or `inline-table` display class widens the page the same way.
 * Absolutely positioned table parts (`thead`, `tbody`, `tr`, `caption`) are
 * blockified and clipped, so they are not the bug.
 *
 * jsdom does not lay out, so the width itself cannot be asserted here. The
 * component test pins the fixed structure, and the source scans fail on the
 * next element or stylesheet rule that repeats the mistake.
 */
import React from 'react'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
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

/** The class must stand alone: `\b` would also match inside Tailwind's `not-sr-only`, which un-hides. */
const SR_ONLY_CLASS = /(?<![\w-])sr-only(?![\w-])/
/** Tailwind's table display utilities, not `table-auto` / `table-fixed` (layout) or `evidence-table`. */
const TABLE_DISPLAY_CLASS = /(?<![\w-])(?:inline-)?table(?![\w-])/

/** Every string and template fragment inside a className value, so `cn()`, ternaries and templates all count. */
function classNameText(initializer: ts.Node | undefined): string {
  if (!initializer) return ''
  const fragments: string[] = []
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      fragments.push(node.text)
      return
    }
    if (ts.isTemplateExpression(node)) {
      fragments.push(node.head.text)
      for (const span of node.templateSpans) {
        collect(span.expression)
        fragments.push(span.literal.text)
      }
      return
    }
    ts.forEachChild(node, collect)
  }
  collect(initializer)
  return fragments.join(' ')
}

/**
 * Every JSX element hidden with `sr-only` that lays out as a table, as 1-based
 * line numbers: a `<table>`, or any element carrying a `table` / `inline-table`
 * class. Parsed, not pattern-matched, so arrow props and nested braces in the
 * opening tag cannot hide one. `md:sr-only` counts, since it breaks at that width.
 */
function srOnlyTableLines(source: string): number[] {
  const file = ts.createSourceFile('scan.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const className = node.attributes.properties.find(
        (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(file) === 'className',
      )
      const text = classNameText(className?.initializer)
      if (SR_ONLY_CLASS.test(text) && (node.tagName.getText(file) === 'table' || TABLE_DISPLAY_CLASS.test(text))) {
        lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}

/** Stylesheet selectors that `@apply sr-only` to a table or a table-display class. */
function srOnlyTableSelectors(css: string): string[] {
  const offenders: string[] = []
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const [, selectorText, body] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const applyDirectives = body!.match(/@apply[^;]*/g) ?? []
    if (!applyDirectives.some(directive => SR_ONLY_CLASS.test(directive))) continue
    for (const selector of selectorText!.split(',').map(part => part.trim())) {
      const lastCompound = selector.split(/[\s>+~]+/).pop() ?? ''
      if (/^table(?![\w-])/.test(lastCompound) || /\.(?:inline-)?table(?![\w-])/.test(lastCompound)) offenders.push(selector)
    }
  }
  return offenders
}

test('the JSX scan recognizes every form of the pattern it guards against', () => {
  const scan = (markup: string) => srOnlyTableLines(`const view = ${markup}`)
  expect(scan('<table className="sr-only" />')).toEqual([1])
  expect(scan("<table className='sr-only' />")).toEqual([1])
  expect(scan('(\n  <table\n    aria-label="t"\n    className={cn(\'sr-only\', extra)}\n  />\n)')).toEqual([2])
  expect(scan('<table onClick={() => go()} className="sr-only" />')).toEqual([1])
  expect(scan('<table className={`${extra} sr-only`} />')).toEqual([1])
  expect(scan("<table className={cn({ wide: isWide }, 'sr-only')} />")).toEqual([1])
  expect(scan("<table className={hidden ? 'sr-only' : ''} />")).toEqual([1])
  expect(scan('<table className="md:sr-only" />')).toEqual([1])
  expect(scan('<div className="sr-only table" />')).toEqual([1])
  expect(scan("<span className={cn('inline-table', 'sr-only')} />")).toEqual([1])

  expect(scan('<div className="sr-only"><table className="evidence-table" /></div>')).toEqual([])
  expect(scan('<tbody className="sr-only" />')).toEqual([])
  expect(scan('<table className="not-sr-only" />')).toEqual([])
  expect(scan('<table className="sr-only-foo" />')).toEqual([])
  expect(scan('<table data-note="sr-only" className="evidence-table" />')).toEqual([])
  expect(scan('<div className="sr-only evidence-table" />')).toEqual([])
  expect(scan('<div className="table-auto sr-only" />')).toEqual([])
})

test('the stylesheet scan recognizes sr-only applied to a table selector', () => {
  expect(srOnlyTableSelectors('.report table { @apply sr-only; }')).toEqual(['.report table'])
  expect(srOnlyTableSelectors('.report > .inline-table, .x { @apply m-0 sr-only; }')).toEqual(['.report > .inline-table'])
  expect(srOnlyTableSelectors('@container (max-width: 40rem) { .results thead { @apply sr-only; } }')).toEqual([])
  expect(srOnlyTableSelectors('.report table { @apply border; }')).toEqual([])
  expect(srOnlyTableSelectors('/* .report table { @apply sr-only; } */ .x { color: red; }')).toEqual([])
})

const SRC_DIR = resolve(import.meta.dirname, '../src')

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(full)
    return entry.name.endsWith('.tsx') ? [full] : []
  })
}

test('no dashboard element that lays out as a table is hidden with sr-only', () => {
  const offenders = tsxFiles(SRC_DIR).flatMap(file =>
    srOnlyTableLines(readFileSync(file, 'utf8')).map(line => `${relative(SRC_DIR, file)}:${line}`),
  )
  expect(offenders).toEqual([])
})

test('no dashboard stylesheet rule applies sr-only to a table', () => {
  expect(srOnlyTableSelectors(readFileSync(join(SRC_DIR, 'styles.css'), 'utf8'))).toEqual([])
})
