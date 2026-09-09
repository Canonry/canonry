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
    fixture.dashboard.portfolioOverview.projects[0]!.providerCoverage = '2 of 4 providers'
    fixture.dashboard.portfolioOverview.projects[1]!.providerCoverage = undefined
  })

  const rows = [...doc.querySelectorAll('.project-row')]
  const [partialMention] = statBlocks(rows[0]!)
  const [fullMention] = statBlocks(rows[1]!)

  const partialCaption = partialMention!.querySelector('.metric-inline-caption')!
  // Caution tone is the whole point: it is why the score above reads amber.
  expect(partialCaption.getAttribute('class')).toContain('text-caution')
  expect(partialCaption.textContent).toBe('Partial sweep: 2 of 4 providers')
  // Truncation is expected in a 9rem column, so the full text must survive on
  // the title attribute where a hover can still reach it.
  expect(partialCaption.getAttribute('title')).toBe('2 of 4 providers')

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
