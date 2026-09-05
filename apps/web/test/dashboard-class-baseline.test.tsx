import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { beforeAll, expect, test } from 'vitest'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { compile } from 'tailwindcss'
import ts from 'typescript'
import { visibilityReportResponseSchema } from '@ainyc/canonry-contracts'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import {
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameVisibilityReportQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../src/api.js'
import { parseVisibilitySelection } from '../src/lib/measurement-view-url.js'

const stylesPath = resolve(import.meta.dirname, '../src/styles.css')
const sourceRoot = resolve(import.meta.dirname, '../src')
const tailwindRoot = resolve(import.meta.dirname, '../node_modules/tailwindcss')

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

function sharedVisibilityReport() {
  const rate = { numerator: 1, denominator: 1, rate: 1 }
  return visibilityReportResponseSchema.parse({
    selection: {
      mode: 'simple',
      queryClass: 'non-brand',
      scope: { id: 'project', label: 'Whole site', kind: 'project', targetCount: 1 },
      provider: null,
      model: null,
      location: { kind: 'all' },
      time: { from: null, to: null },
      revision: null,
      run: { id: 'run-synthetic', explicit: false },
      provenance: { kind: 'frozen-simple', definitionRevision: null },
      measurement: {
        state: 'measured',
        activeRevision: null,
        measuredRevision: null,
        awaitingSweep: false,
        pendingAssignmentCount: 0,
        completedAt: '2026-09-04T12:00:00.000Z',
      },
      availability: { state: 'available' },
    },
    scopeOptions: [{ id: 'project', label: 'Whole site', kind: 'project', targetCount: 1 }],
    filterOptions: { providers: ['openai'], models: [{ provider: 'openai', model: 'search-model' }], locations: [{ kind: 'all' }] },
    populations: [{
      queryClass: 'non-brand',
      summary: {
        queryCount: 1,
        answerCount: 1,
        mentionCoverage: rate,
        citationCoverage: rate,
        propertyReach: rate,
        outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 1 },
      },
      trend: [{
        runId: 'run-synthetic',
        createdAt: '2026-09-04T12:00:00.000Z',
        revision: null,
        provenance: { kind: 'frozen-simple', definitionRevision: null },
        queryCount: 1,
        answerCount: 1,
        mentionCoverage: rate,
        citationCoverage: rate,
        continuity: { state: 'first', comparedRunId: null },
      }],
      queries: {
        items: [{
          queryKey: 'query-synthetic',
          queryId: 'query-synthetic',
          query: 'emergency dentist near me',
          provider: 'openai',
          model: 'search-model',
          location: null,
          targetKeys: ['citypoint'],
          answerCount: 1,
          mentionCoverage: rate,
          citationCoverage: rate,
        }],
        nextCursor: null,
        total: 1,
      },
      evidence: { items: [], nextCursor: null, total: 0 },
      competitorAvailability: { state: 'available' },
      competitors: [],
      observedCompetitors: [],
      breakdown: { properties: [], groups: [] },
    }],
  })
}

function seedSharedVisibilityReports(queryClient: QueryClient, fixture: ReturnType<typeof createDashboardFixture>): void {
  const selection = parseVisibilitySelection({})
  for (const entry of fixture.dashboard.projects) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameVisibilityReportQueryKey({
        client: heyClient,
        path: { name: entry.project.name },
        query: {
          scope: selection.measurementScope,
          scopeKey: selection.measurementScopeKey,
          queryClass: selection.queryClass,
          provider: selection.provider,
          model: selection.model,
          location: selection.location,
          from: selection.from,
          to: selection.to,
          revision: selection.revision,
          runId: selection.measurementRunId,
          queryKey: selection.queryKey,
          limit: 50,
          cursor: undefined,
          search: undefined,
        },
      }),
      sharedVisibilityReport(),
    )
  }
}

async function renderRoute(pathname: string): Promise<string> {
  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // One synchronous render pass, so no query settles. The project overview now
  // waits for the measurement-plan read before picking a surface, so seed the
  // "no advanced plan" answer this baseline is describing.
  for (const entry of fixture.dashboard.projects) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: entry.project.name } }),
      { active: null },
    )
  }
  seedSharedVisibilityReports(queryClient, fixture)
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
}

function classFor(html: string, selector: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const element = doc.querySelector(selector)
  if (!element) {
    const classes = [...doc.querySelectorAll('[class]')]
      .map((candidate) => candidate.getAttribute('class') ?? '')
      .filter((className) => className.includes('page') || className.includes('surface') || className.includes('metric'))
      .slice(0, 80)
      .join('\n')
    throw new Error(`Missing element for selector: ${selector}\nRendered classes:\n${classes}`)
  }
  return element.getAttribute('class') ?? ''
}

test('overview route keeps the dark dashboard class baseline stable', async () => {
  const html = await renderRoute('/')

  expect({
    appShell: classFor(html, '.app-shell'),
    sidebar: classFor(html, '.sidebar'),
    topbar: classFor(html, '.topbar'),
    pageShell: classFor(html, '.page-shell'),
    pageContainer: classFor(html, '.page-container'),
    pageHeader: classFor(html, '.page-header'),
    pageTitle: classFor(html, '.page-title'),
    healthList: classFor(html, '.page-section > .divide-y'),
    firstHealthPill: classFor(html, '.health-pill'),
  }).toMatchInlineSnapshot(`
    {
      "appShell": "app-shell ",
      "firstHealthPill": "health-pill health-pill-ok",
      "healthList": "divide-y divide-default border-y border-default",
      "pageContainer": "page-container",
      "pageHeader": "page-header",
      "pageShell": "page-shell",
      "pageTitle": "page-title",
      "sidebar": "sidebar",
      "topbar": "topbar",
    }
  `)
})

test('project route keeps the shared-report class baseline stable', async () => {
  const html = await renderRoute('/projects/Citypoint%20Dental%20NYC')

  expect({
    pageContainer: classFor(html, '.page-container'),
    pageHeader: classFor(html, '.page-header'),
    pageTitle: classFor(html, '.page-title'),
    reportSection: classFor(html, '[aria-label="AI visibility results"]'),
    reportPopulation: classFor(html, '[aria-label="Non-brand queries"]'),
    trendChart: classFor(html, '.visibility-trend-chart'),
    queryTable: classFor(html, '.evidence-table'),
  }).toMatchInlineSnapshot(`
    {
      "pageContainer": "page-container",
      "pageHeader": "page-header",
      "pageTitle": "page-title",
      "queryTable": "evidence-table",
      "reportPopulation": "py-6",
      "reportSection": "page-section-divider",
      "trendChart": "visibility-trend-chart",
    }
  `)
})

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name)
    return entry.isDirectory()
      ? sourceFiles(child)
      : /\.[jt]sx?$/.test(entry.name) ? [child] : []
  })
}

function staticClassNames() {
  const classes = new Set<string>()

  const add = (value: string) => {
    for (const token of value.split(/\s+/)) if (token) classes.add(token)
  }
  const addChunk = (value: string, startsAtBoundary: boolean, endsAtBoundary: boolean) => {
    for (const match of value.matchAll(/\S+/g)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      if ((start > 0 || startsAtBoundary) && (end < value.length || endsAtBoundary)) add(match[0])
    }
  }
  const collect = (expression: ts.Expression): void => {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      add(expression.text)
    } else if (ts.isTemplateExpression(expression)) {
      addChunk(expression.head.text, true, false)
      expression.templateSpans.forEach((span, index) => {
        const previous = index === 0 ? expression.head.text : expression.templateSpans[index - 1].literal.text
        const next = span.literal.text
        if ((previous.length === 0 || /\s$/.test(previous)) && (next.length === 0 || /^\s/.test(next))) {
          collect(span.expression)
        }
        addChunk(span.literal.text, false, index === expression.templateSpans.length - 1)
      })
    } else if (ts.isConditionalExpression(expression)) {
      collect(expression.whenTrue)
      collect(expression.whenFalse)
    } else if (ts.isArrayLiteralExpression(expression)) {
      expression.elements.forEach((element) => {
        if (!ts.isSpreadElement(element)) collect(element)
      })
    } else if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression)) {
      collect(expression.expression)
    } else if (ts.isBinaryExpression(expression)
      && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expression.operatorToken.kind)) {
      collect(expression.right)
    } else if (ts.isCallExpression(expression)) {
      expression.arguments.forEach((argument) => collect(argument))
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.text === 'className') {
      if (node.initializer && ts.isStringLiteral(node.initializer)) add(node.initializer.text)
      if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) collect(node.initializer.expression)
    } else if (ts.isPropertyAssignment(node)) {
      const name = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name
      if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'className') collect(node.initializer)
    }
    ts.forEachChild(node, visit)
  }

  for (const file of sourceFiles(sourceRoot)) {
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TS
    visit(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind))
  }
  return [...classes]
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cssClassSelector(token: string) {
  const escaped = token.replace(/(^-?\d)|[^\w-]/g, (character, leadingDigit) => (
    leadingDigit ? `\\${character.codePointAt(0)?.toString(16)} ` : `\\${character}`
  ))
  return new RegExp(`\\.${escapeRegExp(escaped)}(?=$|[\\s,.:#>+~{}\\[\\]])`)
}

function isTailwindMarker(token: string) {
  return token === 'group' || token.startsWith('group/') || token === 'peer' || token.startsWith('peer/')
}

async function loadTailwindStylesheet(id: string) {
  if (id !== 'tailwindcss' && !id.startsWith('tailwindcss/')) {
    throw new Error(`Unexpected stylesheet import: ${id}`)
  }
  const filename = id === 'tailwindcss' ? 'index.css' : `${id.slice('tailwindcss/'.length)}.css`
  const path = resolve(tailwindRoot, filename)
  return { path, base: dirname(path), content: readFileSync(path, 'utf8') }
}

test('every static className token has a stylesheet selector or Tailwind utility', async () => {
  const styles = readFileSync(stylesPath, 'utf8')
  const classNames = staticClassNames().sort()
  const compiler = await compile(styles, {
    from: stylesPath,
    base: dirname(stylesPath),
    loadStylesheet: loadTailwindStylesheet,
  })
  const css = compiler.build(classNames)
  const missing = classNames.filter((token) => !isTailwindMarker(token) && !cssClassSelector(token).test(css))

  expect(missing).toEqual([])
})
