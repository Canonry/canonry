import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { compileAppStyles } from './compiled-app-css.js'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ProjectSubnav, type ProjectPageTab } from '../src/pages/ProjectPage.js'

const items = [
  { key: 'overview', label: 'AI Visibility' },
  { key: 'search-console', label: 'Search Engines' },
  { key: 'seo-data', label: 'SEO' },
  { key: 'activity', label: 'Activity' },
  { key: 'agent-readiness', label: 'Agent Readiness' },
  { key: 'journeys', label: 'Journeys' },
  { key: 'traffic', label: 'Server traffic' },
].map(item => ({
  ...item,
  key: item.key as ProjectPageTab,
  // As in ProjectPage: AI Visibility is the project root, the parent of every other section.
  href: item.key === 'overview' ? '/projects/demo' : `/projects/demo/${item.key}`,
}))
const overflowItems = [
  { key: 'conversions' as const, label: 'Conversions', href: '/projects/demo/conversions' },
  { key: 'local' as const, label: 'Local Presence', href: '/projects/demo/local' },
  { key: 'queries' as const, label: 'Queries', href: '/projects/demo/queries' },
  { key: 'backlinks' as const, label: 'Backlinks', href: '/projects/demo/backlinks' },
  { key: 'history' as const, label: 'Change History', href: '/projects/demo/history' },
]
const settingsItem = { key: 'settings' as const, label: 'Settings', href: '/projects/demo/settings' }
const baseWidths: Record<string, number> = {
  overview: 112, 'search-console': 132, 'seo-data': 56, activity: 84, 'agent-readiness': 108, journeys: 96, traffic: 132,
  conversions: 104, local: 124, queries: 76, backlinks: 92, history: 128, more: 80, settings: 88,
}
const moreLabels = ['Conversions', 'Local Presence', 'Queries', 'Backlinks', 'Change History']
let widths = { ...baseWidths }
let containerWidth = 1600
let resize: (() => void) | undefined

beforeEach(() => {
  containerWidth = 1600
  widths = { ...baseWidths }
  resize = undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains('project-subnav')
      ? containerWidth
      : widths[this.dataset.projectTab ?? ''] ?? 0
    return { x: 0, y: 0, width, height: 44, top: 0, left: 0, right: width, bottom: 44, toJSON() {} }
  })
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const style = getStyle(element)
    if (element.classList.contains('project-subnav')) style.columnGap = '4px'
    return style
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function renderNav(activeTab: ProjectPageTab = 'overview', filtered = false) {
  const root = createRootRoute({
    validateSearch: search => search,
    component: () => <ProjectSubnav
      items={filtered ? items.filter(item => ['overview', 'agent-readiness'].includes(item.key)) : items}
      overflowItems={filtered ? [] : overflowItems}
      settingsItem={filtered ? null : settingsItem}
      activeTab={activeTab}
    />,
  })
  const projectRoot = createRoute({ getParentRoute: () => root, path: '/projects/demo' })
  const route = createRoute({ getParentRoute: () => root, path: '/projects/demo/$section' })
  const router = createRouter({
    routeTree: root.addChildren([projectRoot, route]),
    history: createMemoryHistory({ initialEntries: [`/projects/demo${activeTab === 'overview' ? '' : `/${activeTab}`}?measurementScope=market&measurementScopeKey=metro-alpha&runId=drawer-run&onboarding=1`] }),
  })
  await router.load()
  const view = render(<RouterProvider router={router} />)
  const nav = await view.findByRole('navigation', { name: 'Project sections' })
  return { ...view, nav, router }
}

test('wide navigation keeps the primary sections and Settings visible', async () => {
  const { nav } = await renderNav()
  expect(within(nav).getAllByRole('link').map(item => item.textContent)).toEqual([
    'AI Visibility', 'Search Engines', 'SEO', 'Activity', 'Agent Readiness', 'Journeys', 'Server traffic', 'Settings',
  ])
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toEqual(moreLabels)
})

test('a narrow container moves excess primary sections into More without a viewport resize', async () => {
  const { nav } = await renderNav()
  const viewportWidth = window.innerWidth
  act(() => { containerWidth = 500; resize?.() })
  expect(window.innerWidth).toBe(viewportWidth)
  expect(within(nav).queryByRole('link', { name: 'Activity' })).toBeNull()
  expect(within(nav).getByRole('link', { name: 'SEO' })).toBeTruthy()
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toEqual([
    'Activity', 'Agent Readiness', 'Journeys', 'Server traffic', ...moreLabels,
  ])
  act(() => { containerWidth = 1600; resize?.() })
  expect(within(nav).getByRole('link', { name: 'Agent Readiness' })).toBeTruthy()
  expect(within(nav).queryByRole('menu')).toBeNull()
})

test('the active primary section stays visible and Settings overflows on very narrow panels', async () => {
  containerWidth = 220
  const { nav } = await renderNav('agent-readiness')
  expect(within(nav).getAllByRole('link').map(item => item.textContent)).toEqual(['Agent Readiness'])
  expect(within(nav).getByRole('link', { name: 'Agent Readiness' }).getAttribute('aria-current')).toBe('page')
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getByRole('menuitem', { name: 'Settings' })).toBeTruthy()
})

test('the overflow menu supports keyboard navigation and restores focus on Escape', async () => {
  const { nav } = await renderNav()
  const trigger = within(nav).getByRole('button', { name: 'More' })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  await waitFor(() => expect(document.activeElement?.textContent).toBe('Conversions'))
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  expect(document.activeElement?.textContent).toBe('Change History')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement?.textContent).toBe('Conversions')
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(within(nav).queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

// The subnav's Settings tab exists only in embeds; operators reach Settings
// through the sidebar's Project settings link (portfolio-route.test.tsx).
test('overflow destinations and the embed Settings tab retain measurement and drawer URL state', async () => {
  containerWidth = 650
  const { nav, router } = await renderNav()
  const settings = within(nav).getByRole('link', { name: 'Settings' }) as HTMLAnchorElement
  expect(settings.href).toContain('runId=drawer-run')
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  const queries = within(nav).getByRole('menuitem', { name: 'Queries' }) as HTMLAnchorElement
  expect(queries.href).toContain('measurementScope=market')
  expect(queries.href).toContain('measurementScopeKey=metro-alpha')
  expect(queries.href).toContain('runId=drawer-run')
  expect(queries.href).not.toContain('onboarding')
  fireEvent.click(queries)
  await waitFor(() => expect(router.state.location.pathname).toBe('/projects/demo/queries'))
  expect(within(nav).queryByRole('menu')).toBeNull()
})

test('embed-filtered sections remain filtered when they overflow', async () => {
  containerWidth = 180
  const { nav } = await renderNav('overview', true)
  expect(within(nav).queryByRole('link', { name: 'Agent Readiness' })).toBeNull()
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Agent Readiness'])
  expect(within(nav).queryByText('Settings')).toBeNull()
  expect(within(nav).queryByText('Queries')).toBeNull()
})

const primaryLabels = ['AI Visibility', 'Search Engines', 'SEO', 'Activity', 'Agent Readiness', 'Journeys', 'Server traffic']

function currentPageLinks(nav: HTMLElement) {
  return within(nav).getAllByRole('link').filter(link => link.getAttribute('aria-current') === 'page').map(link => link.textContent)
}

test.each([
  { tab: 'activity', label: 'Activity', row: [...primaryLabels, 'Settings'] },
  { tab: 'history', label: 'Change History', row: [...primaryLabels, 'Change History', 'Settings'] },
] as const)('the row names the open $label section as the current page', async ({ tab, label, row }) => {
  const { nav } = await renderNav(tab)
  expect(within(nav).getAllByRole('link').map(link => link.textContent)).toEqual(row)
  expect(currentPageLinks(nav)).toEqual([label])
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toEqual(moreLabels.filter(name => name !== label))
  fireEvent.pointerDown(document.body)
  expect(within(nav).queryByRole('menu')).toBeNull()
})

test.each([
  { tab: 'history', label: 'Change History', width: 400 },
  { tab: 'settings', label: 'Settings', width: 150 },
] as const)('the open $label section keeps its tab when the panel is too narrow for the rest', async ({ tab, label, width }) => {
  containerWidth = width
  const { nav } = await renderNav(tab)
  expect(currentPageLinks(nav)).toEqual([label])
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toContain('AI Visibility')
  expect(within(nav).queryByRole('menuitem', { name: label })).toBeNull()
})

test('a long active tab remains reachable at narrow widths and other tabs return when widened', async () => {
  containerWidth = 210
  widths['agent-readiness'] = 280
  const { nav } = await renderNav('agent-readiness')
  const active = within(nav).getByRole('link', { name: 'Agent Readiness' })
  expect(active.classList.contains('project-subnav-current')).toBe(true)
  expect(active.querySelector('.project-subnav-label')).toBeTruthy()
  expect(within(nav).getAllByRole('link')).toHaveLength(1)
  expect(within(nav).getByRole('button', { name: 'More' })).toBeTruthy()
  act(() => { containerWidth = 1600; widths['agent-readiness'] = baseWidths['agent-readiness']!; resize?.() })
  expect(within(nav).getAllByRole('link')).toHaveLength(8)
  expect(within(nav).getByRole('link', { name: 'Agent Readiness' }).getAttribute('aria-current')).toBe('page')
})

test('font or label width changes remeasure the available tab budget', async () => {
  containerWidth = 500
  const { nav } = await renderNav()
  expect(within(nav).getByRole('link', { name: 'SEO' })).toBeTruthy()
  act(() => { widths['seo-data'] = 200; resize?.() })
  expect(within(nav).queryByRole('link', { name: 'SEO' })).toBeNull()
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getByRole('menuitem', { name: 'SEO' })).toBeTruthy()
})

test('compiled navigation styles prevent wrapping without hiding the overflow menu', async () => {
  const css = await compileAppStyles([])
  const rule = (name: string) => css.match(new RegExp(`\\.${name} \\{([^}]+)`))![1]
  expect(rule('project-subnav')).toContain('flex-wrap: nowrap')
  expect(rule('project-subnav')).not.toContain('overflow: hidden')
  expect(rule('project-subnav-measure')).toContain('position: absolute')
  expect(rule('project-subnav-measure')).toContain('overflow: hidden')
  expect(rule('project-subnav-current')).toContain('flex-shrink: 1')
  expect(css.indexOf('.project-subnav-current {')).toBeGreaterThan(css.indexOf('.project-subnav-link {'))
  expect(rule('project-subnav-menu')).toContain('position: absolute')
  expect(rule('project-subnav-menu')).toContain('overflow-y: auto')
})
