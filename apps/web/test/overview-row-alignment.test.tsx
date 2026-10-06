import { aggregateSentiment } from '@ainyc/canonry-contracts'
import { beforeAll, expect, test } from 'vitest'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'

import { AccountProvider } from '../src/contexts/account-context.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'

// Regression coverage for the "Mentioned" / "Pressure" stat-cell alignment
// defect on the /projects overview rows: the two stat cells in a
// `.project-row` must expose the SAME label/value/caption structure so
// `lg:items-center` can center them onto a shared baseline. Before the fix,
// "Mentioned" carried an optional 4th providerCoverage line and "Pressure"
// had no caption at all, so the two cells drifted to different heights.
//
// Renders via `renderToStaticMarkup` + `DOMParser`, mirroring
// `dashboard-class-baseline.test.tsx` and `app.test.tsx` — this suite is a
// structural DOM assertion, not a browser layout test.

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

async function renderOverview(
  mutate?: (fixture: ReturnType<typeof createDashboardFixture>) => void,
  viewer = false,
): Promise<Document> {
  const fixture = createDashboardFixture({})
  mutate?.(fixture)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/'] })
  await router.load()

  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={viewer ? { name: 'viewer', role: 'viewer' } : null}><DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider></AccountProvider>
    </QueryClientProvider>,
  )

  return new DOMParser().parseFromString(html, 'text/html')
}

function statBlocks(row: Element): Element[] {
  return [...row.querySelectorAll('.project-row-stat .metric-inline-block')]
}

function slotClasses(block: Element): string[] {
  return [...block.children].map((child) => child.getAttribute('class') ?? '')
}

test('every project row has exactly two stat cells, each a three-slot label/value/caption block', async () => {
  const doc = await renderOverview()

  const rows = [...doc.querySelectorAll('.project-row')]
  expect(rows.length).toBe(3)

  for (const row of rows) {
    const blocks = statBlocks(row)
    expect(blocks.length).toBe(2)

    for (const block of blocks) {
      const slots = slotClasses(block)
      expect(slots.length).toBe(3)
      expect(slots[0]).toBe('metric-inline-label')
      expect(slots[1]!.startsWith('metric-inline-value')).toBe(true)
      expect(slots[2]!.startsWith('metric-inline-caption')).toBe(true)
    }
  }
})

test('the pressure label reads the single word "Pressure" and keeps its full meaning for screen readers', async () => {
  const doc = await renderOverview()

  const rows = [...doc.querySelectorAll('.project-row')]
  expect(rows.length).toBeGreaterThan(0)

  for (const row of rows) {
    const [, pressureBlock] = statBlocks(row)
    const label = pressureBlock!.querySelector('.metric-inline-label')!

    // The VISIBLE token is one word so it can never wrap in the 9rem column.
    // `aria-label` on a <p> is not a valid accessible name (role `paragraph`
    // does not support naming), so the full meaning has to ride a
    // visually-hidden span instead — assert both halves separately.
    const visible = label.querySelector('[aria-hidden="true"]')!
    expect(visible.textContent).toBe('Pressure')
    expect(visible.textContent).not.toMatch(/\s/)
    expect(label.querySelector('.sr-only')!.textContent).toBe('Competitor pressure')
    expect(label.getAttribute('aria-label')).toBe(null)
  }
})

test('a partial sweep keeps its data-validity caveat in the caution tone rather than as faint text', async () => {
  const doc = await renderOverview((fixture) => {
    fixture.dashboard.portfolioOverview.projects[0]!.providerCoverage = '2 of 4 engines'
    fixture.dashboard.portfolioOverview.projects[1]!.providerCoverage = undefined
  })

  const rows = [...doc.querySelectorAll('.project-row')]
  const [partialMention] = statBlocks(rows[0]!)
  const [fullMention] = statBlocks(rows[1]!)

  const partialCaption = partialMention!.querySelector('.metric-inline-caption')!
  // Caution tone is the whole point: it is why the score above reads amber.
  expect(partialCaption.getAttribute('class')).toContain('text-caution')
  expect(partialCaption.textContent).toBe('Partial sweep: 2 of 4 engines')
  // Truncation is expected in a 9rem column, so the full text must survive on
  // the title attribute where a hover can still reach it.
  expect(partialCaption.getAttribute('title')).toBe('2 of 4 engines')

  // A complete sweep carries no caveat and must NOT borrow the caution tone.
  const fullCaption = fullMention!.querySelector('.metric-inline-caption')!
  expect(fullCaption.getAttribute('class')).not.toContain('text-caution')
})

test('a project with providerCoverage and one without it render the same number of slots', async () => {
  const doc = await renderOverview((fixture) => {
    fixture.dashboard.portfolioOverview.projects[0]!.providerCoverage = 'gemini only'
    fixture.dashboard.portfolioOverview.projects[1]!.providerCoverage = undefined
  })

  const rows = [...doc.querySelectorAll('.project-row')]
  const [withCoverageMention] = statBlocks(rows[0]!)
  const [withoutCoverageMention] = statBlocks(rows[1]!)

  expect(withCoverageMention!.children.length).toBe(3)
  expect(withoutCoverageMention!.children.length).toBe(3)
  expect(withCoverageMention!.children.length).toBe(withoutCoverageMention!.children.length)

  // The providerCoverage text must not be dropped — it has to land inside
  // the caption slot alongside the delta, not vanish or grow a 4th slot.
  const caption = withCoverageMention!.querySelector('.metric-inline-caption')!
  expect(caption.textContent).toMatch(/gemini only/)
})

test('does not report unconfigured providers to a viewer whose settings are unavailable', async () => {
  const doc = await renderOverview(fixture => { fixture.dashboard.settings.providerStatuses = [] }, true)
  expect(doc.body.textContent).not.toContain('None configured')
  expect(doc.body.textContent).not.toContain('0 of 0 configured')
  expect(doc.body.textContent).toContain('Infrastructure')
})

test('shows each project mention rate through formatPercent, not as a bare number', async () => {
  const doc = await renderOverview(fixture => {
    // 2 of 3 queries mentioned is 66.666667 on the wire; the others are whole.
    fixture.dashboard.portfolioOverview.projects[0]!.mentionScore = 66.666667
  })
  const mentioned = [...doc.querySelectorAll('.project-row')]
    .map(row => statBlocks(row)[0]!.querySelector('.metric-inline-value')?.textContent)
  expect(mentioned).toEqual(['66.7%', '74.0%', '58.0%'])
})

test('shows an awaiting-baseline state rather than zero performance or stable results', async () => {
  const doc = await renderOverview(fixture => {
    fixture.dashboard.portfolioOverview.projects.forEach(project => { project.hasMeasurement = false; project.mentionScore = 0 })
    fixture.dashboard.portfolioOverview.attentionItems = [{ id: 'attention_stable', tone: 'positive', title: 'All projects stable', detail: 'No changes' }]
  }, true)
  expect([...doc.querySelectorAll('.metric-inline-value')].map(node => node.textContent)).toEqual(Array(6).fill('Not measured'))
  expect(doc.body.textContent).toContain('Awaiting first measurement')
  expect(doc.body.textContent).not.toContain('All projects stable')
})


test('shows MCP as a separate infrastructure row for viewers', async () => {
  const doc = await renderOverview(fixture => {
    fixture.health.apiStatus.mcp = { status: 'available' }
  }, true)
  const label = [...doc.querySelectorAll('p')].find(node => node.textContent === 'MCP')!
  expect(label).toBeDefined()
  const row = label.parentElement!.parentElement!
  expect(row.textContent).toContain('Available')
  expect(row.textContent).not.toContain('API')
  expect(row.querySelector('[title]')?.getAttribute('title')).toContain('not an individual client connection')
})

/**
 * A project's sentiment overview as the server sends it. The overview figure
 * reads `branded`; `overall` and `nonBrand` get their own, different counts so
 * a row that read either would show a different figure.
 */
function sentimentOverview(branded: Parameters<typeof aggregateSentiment>[0]) {
  const selection = { mode: 'simple' as const, scope: 'project' as const, queryClass: 'branded' as const, runId: 'run', revision: null, evaluationDefinitionId: 'definition' }
  const ratings = (count: number, outcome: 'favorable' | 'mixed' | 'unfavorable') => Array.from({ length: count }, (_, index) => ({ assessmentId: `${outcome}${index}`, sourceSnapshotId: `${outcome}${index}`, outcome }))
  const nonBrand = { ...aggregateSentiment([...ratings(19, 'favorable'), ...ratings(1, 'mixed')]), reason: null, runIds: ['run'], selection: { ...selection, queryClass: 'non-brand' as const } }
  return {
    configured: true,
    branded: { ...aggregateSentiment(branded), reason: null, runIds: ['run'], selection },
    nonBrand,
    overall: { ...aggregateSentiment([...branded, ...ratings(19, 'favorable'), ...ratings(1, 'mixed')]), reason: null, runIds: ['run'], queryClass: 'all' as const },
  }
}

test('one branded sentiment value aligns with the other stats and keeps help outside the project link', async () => {
  // Ten branded ratings, the fewest that show a favorable share: 5 favorable, 5 mixed.
  const sentiment = sentimentOverview(Array.from({ length: 10 }, (_, index) => ({
    assessmentId: `a${index}`, sourceSnapshotId: `s${index}`, outcome: index % 2 === 0 ? 'favorable' as const : 'mixed' as const,
  })))
  // Overall pools 24 of 30 favorable and non-brand 19 of 20: neither is the figure.
  expect([sentiment.branded.score.favorableDisplay, sentiment.overall.score.favorableDisplay, sentiment.nonBrand.score.favorableDisplay]).toEqual(['50.0%', '80.0%', '95.0%'])
  const doc = await renderOverview(fixture => {
    fixture.dashboard.portfolioOverview.projects[0]!.sentiment = sentiment
  })
  const metric = doc.querySelector('[data-sentiment-score]')!
  const row = metric.closest('.project-row')!
  const links = row.querySelectorAll('a')
  const help = metric.querySelector('button')!
  expect(links).toHaveLength(1)
  expect(links[0]!.contains(help)).toBe(false)
  expect(links[0]!.getAttribute('href')).toMatch(/^\/projects\//)
  // The branded counts, 10 of 10 judged, never overall's 30 of 30.
  expect(help.getAttribute('aria-label')).toContain('10 of 10 judged')
  expect(help.getAttribute('aria-label')).not.toContain('30 of 30')
  expect(row.classList.contains('project-row-with-sentiment')).toBe(true)
  expect(statBlocks(row)).toHaveLength(3)
  expect(metric.querySelector('.metric-inline-block')!.children).toHaveLength(3)
  expect(metric.querySelector('.metric-inline-label')!.textContent).toBe('Sentiment')
  expect(metric.querySelector('.metric-inline-value')!.textContent).toBe('50.0% favorable judgments, branded queries')
  expect(metric.textContent).not.toContain('80.0%')
  expect(metric.textContent).not.toContain('95.0%')
  expect(metric.textContent).not.toContain('Unavailable')
  expect(metric.textContent).not.toContain('judged')
  expect(metric.querySelectorAll('.metric-inline-value')).toHaveLength(1)
})

test('when any project shows sentiment, every row keeps the same columns so Mentioned lines up', async () => {
  const doc = await renderOverview(fixture => {
    fixture.dashboard.portfolioOverview.projects[0]!.sentiment = sentimentOverview(Array.from({ length: 10 }, (_, index) => ({
      assessmentId: `a${index}`, sourceSnapshotId: `s${index}`, outcome: 'favorable' as const,
    })))
  })
  const rows = [...doc.querySelectorAll('.project-row')]
  expect(rows.length).toBeGreaterThan(1)
  for (const row of rows) {
    // Same grid template and the same number of stat cells in every row.
    expect(row.classList.contains('project-row-with-sentiment')).toBe(true)
    expect(row.querySelectorAll(':scope > .project-row-stat')).toHaveLength(3)
    expect(row.querySelector(':scope > .project-row-stat .metric-inline-label')!.textContent).toBe('Mentioned')
  }
  const placeholders = doc.querySelectorAll('[data-sentiment-placeholder]')
  expect(placeholders).toHaveLength(rows.length - 1)
  for (const cell of placeholders) {
    expect(cell.getAttribute('aria-hidden')).toBe('true')
    expect(cell.textContent).toBe('')
  }
})

test('with no project showing sentiment, rows keep two stat cells and no reserved column', async () => {
  const doc = await renderOverview()
  const rows = [...doc.querySelectorAll('.project-row')]
  for (const row of rows) {
    expect(row.classList.contains('project-row-with-sentiment')).toBe(false)
    expect(row.querySelectorAll(':scope > .project-row-stat')).toHaveLength(2)
  }
  expect(doc.querySelectorAll('[data-sentiment-placeholder]')).toHaveLength(0)
})

test('below 10 branded ratings the value reads "too few", as the Tone card does, whatever overall counts', async () => {
  const sentiment = sentimentOverview([
    { assessmentId: 'one', sourceSnapshotId: 'one', outcome: 'favorable' },
    { assessmentId: 'two', sourceSnapshotId: 'two', outcome: 'mixed' },
  ])
  // Overall pools 22 ratings, enough for a share; branded has 2.
  expect([sentiment.branded.coverage.judged, sentiment.overall.coverage.judged]).toEqual([2, 22])
  const doc = await renderOverview(fixture => {
    fixture.dashboard.portfolioOverview.projects[0]!.sentiment = sentiment
  })
  const metric = doc.querySelector('[data-sentiment-score]')!
  // The slot stays, so the row keeps its grid; the counts stay in the ⓘ.
  expect(metric.closest('.project-row')!.classList.contains('project-row-with-sentiment')).toBe(true)
  expect(metric.querySelector('button')!.getAttribute('aria-label')).toContain('2 of 2 judged')
  expect(metric.querySelector('.metric-inline-value')!.textContent).toBe('too few ratings for a favorable share, 2 of 10 needed, branded queries')
  expect(metric.textContent).not.toContain('%')
})

test('an unjudged branded score leaves no sentiment metric or grid slot, even with judged overall and non-brand scores', async () => {
  const sentiment = sentimentOverview([])
  expect([sentiment.branded.coverage.judged, sentiment.nonBrand.coverage.judged, sentiment.overall.coverage.judged]).toEqual([0, 20, 20])
  const doc = await renderOverview(fixture => {
    fixture.dashboard.portfolioOverview.projects[0]!.sentiment = sentiment
  })
  const row = doc.querySelector('.project-row')!
  expect(row.querySelector('[data-sentiment-score]')).toBeNull()
  expect(row.classList.contains('project-row-with-sentiment')).toBe(false)
  expect(statBlocks(row)).toHaveLength(2)
  expect(doc.querySelectorAll('[data-sentiment-placeholder]')).toHaveLength(0)
})
