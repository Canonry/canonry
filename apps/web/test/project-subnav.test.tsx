import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { compileAppStyles } from './compiled-app-css.js'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { projectSectionTabs, ProjectSubnav, type ProjectPageTab } from '../src/pages/ProjectPage.js'

// The sections ProjectPage itself hands the subnav, for an account that sees Journeys.
const { primary: items, overflow: overflowItems } = projectSectionTabs('/projects/demo', { journeys: true })
const settingsItem = { key: 'settings' as const, label: 'Settings', href: '/projects/demo/settings' }
const baseWidths: Record<string, number> = {
  overview: 112, queries: 76, 'search-console': 132, 'seo-data': 56, activity: 84, 'agent-readiness': 108, journeys: 96, traffic: 132,
  conversions: 104, local: 124, backlinks: 92, history: 128, more: 80, settings: 88,
}
const primaryLabels = ['AI Visibility', 'Search engines', 'SEO', 'Activity', 'Agent Readiness', 'Journeys', 'Server traffic', 'Queries']
const moreLabels = ['Conversions', 'Local presence', 'Backlinks', 'Change history']
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

test('the section list leads with AI Visibility and ends with Queries, in sentence case, and leaves Journeys out for view-only accounts', () => {
  expect(items.map(item => [item.key, item.label, item.href])).toEqual([
    ['overview', 'AI Visibility', '/projects/demo'],
    ['search-console', 'Search engines', '/projects/demo/search-console'],
    ['seo-data', 'SEO', '/projects/demo/seo-data'],
    ['activity', 'Activity', '/projects/demo/activity'],
    ['agent-readiness', 'Agent Readiness', '/projects/demo/agent-readiness'],
    ['journeys', 'Journeys', '/projects/demo/journeys'],
    ['traffic', 'Server traffic', '/projects/demo/traffic'],
    ['queries', 'Queries', '/projects/demo/queries'],
  ])
  expect(overflowItems.map(item => [item.key, item.label, item.href])).toEqual([
    ['conversions', 'Conversions', '/projects/demo/conversions'],
    ['local', 'Local presence', '/projects/demo/local'],
    ['backlinks', 'Backlinks', '/projects/demo/backlinks'],
    ['history', 'Change history', '/projects/demo/history'],
  ])
  const viewer = projectSectionTabs('/projects/demo', { journeys: false })
  expect(viewer.primary.map(item => item.label)).toEqual(primaryLabels.filter(label => label !== 'Journeys'))
  expect(viewer.overflow.map(item => item.label)).toEqual(moreLabels)
})

test('wide navigation keeps the primary sections and Settings visible', async () => {
  const { nav } = await renderNav()
  expect(within(nav).getAllByRole('link').map(item => item.textContent)).toEqual([...primaryLabels, 'Settings'])
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toEqual(moreLabels)
})

test('a narrow container moves the later primary sections into More, Queries first', async () => {
  const { nav } = await renderNav()
  const viewportWidth = window.innerWidth
  // 600px fits AI Visibility, Search engines, SEO and Activity beside More and Settings.
  act(() => { containerWidth = 600; resize?.() })
  expect(window.innerWidth).toBe(viewportWidth)
  expect(within(nav).getAllByRole('link').map(item => item.textContent)).toEqual(['AI Visibility', 'Search engines', 'SEO', 'Activity', 'Settings'])
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toEqual([
    'Agent Readiness', 'Journeys', 'Server traffic', 'Queries', ...moreLabels,
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
  expect(document.activeElement?.textContent).toBe('Change history')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement?.textContent).toBe('Conversions')
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(within(nav).queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

// The subnav's Settings tab exists only in embeds; operators reach Settings
// through the sidebar's Project settings link (portfolio-route.test.tsx).
test('row tabs, overflow destinations and the embed Settings tab retain measurement and drawer URL state', async () => {
  containerWidth = 650
  const { nav, router } = await renderNav()
  const settings = within(nav).getByRole('link', { name: 'Settings' }) as HTMLAnchorElement
  expect(settings.href).toContain('runId=drawer-run')
  const searchEngines = within(nav).getByRole('link', { name: 'Search engines' }) as HTMLAnchorElement
  expect(searchEngines.href).toContain('measurementScope=market')
  expect(searchEngines.href).toContain('measurementScopeKey=metro-alpha')
  expect(searchEngines.href).toContain('runId=drawer-run')
  expect(searchEngines.href).not.toContain('onboarding')
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  const backlinks = within(nav).getByRole('menuitem', { name: 'Backlinks' }) as HTMLAnchorElement
  expect(backlinks.href).toContain('measurementScope=market')
  expect(backlinks.href).toContain('measurementScopeKey=metro-alpha')
  expect(backlinks.href).toContain('runId=drawer-run')
  expect(backlinks.href).not.toContain('onboarding')
  fireEvent.click(backlinks)
  await waitFor(() => expect(router.state.location.pathname).toBe('/projects/demo/backlinks'))
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

function currentPageLinks(nav: HTMLElement) {
  return within(nav).getAllByRole('link').filter(link => link.getAttribute('aria-current') === 'page').map(link => link.textContent)
}

test.each([
  { tab: 'activity', label: 'Activity', row: [...primaryLabels, 'Settings'] },
  { tab: 'history', label: 'Change history', row: [...primaryLabels, 'Change history', 'Settings'] },
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
  { tab: 'history', label: 'Change history', width: 400 },
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
  expect(within(nav).getAllByRole('link').map(link => link.textContent)).toEqual([...primaryLabels, 'Settings'])
  expect(within(nav).getByRole('link', { name: 'Agent Readiness' }).getAttribute('aria-current')).toBe('page')
})

test('font or label width changes remeasure the available tab budget', async () => {
  containerWidth = 600
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
