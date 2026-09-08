import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { compile } from 'tailwindcss'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ProjectSubnav, type ProjectPageTab } from '../src/pages/ProjectPage.js'

const items = [
  { key: 'overview', label: 'AI Visibility' },
  { key: 'search-console', label: 'Search Engines' },
  { key: 'activity', label: 'Activity' },
  { key: 'technical-aeo', label: 'Site Health' },
  { key: 'conversions', label: 'Conversions' },
  { key: 'local', label: 'Local Presence' },
  { key: 'queries', label: 'Queries' },
  { key: 'backlinks', label: 'Backlinks' },
].map(item => ({ ...item, key: item.key as ProjectPageTab, href: `/projects/demo/${item.key}` }))
const overflowItems = [
  { key: 'report' as const, label: 'Report', href: '/projects/demo/report' },
  { key: 'history' as const, label: 'Change History', href: '/projects/demo/history' },
]
const settingsItem = { key: 'settings' as const, label: 'Settings', href: '/projects/demo/settings' }
const baseWidths: Record<string, number> = {
  overview: 112, 'search-console': 132, activity: 84, 'technical-aeo': 108,
  conversions: 120, local: 140, queries: 88, backlinks: 100, more: 80, settings: 88,
}
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
      items={filtered ? items.filter(item => ['overview', 'technical-aeo'].includes(item.key)) : items}
      overflowItems={filtered ? [] : overflowItems}
      settingsItem={filtered ? null : settingsItem}
      activeTab={activeTab}
    />,
  })
  const route = createRoute({ getParentRoute: () => root, path: '/projects/demo/$section' })
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/projects/demo/${activeTab}?measurementScope=market&measurementScopeKey=metro-alpha&runId=drawer-run&onboarding=1`] }),
  })
  await router.load()
  const view = render(<RouterProvider router={router} />)
  const nav = await view.findByRole('navigation', { name: 'Project sections' })
  return { ...view, nav, router }
}

test('wide navigation keeps primary sections and Settings visible', async () => {
  const { nav } = await renderNav()
  expect(within(nav).getAllByRole('link')).toHaveLength(9)
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Report', 'Change History'])
})

test('a narrow container moves excess sections into More without a viewport resize', async () => {
  const { nav } = await renderNav()
  const viewportWidth = window.innerWidth
  act(() => { containerWidth = 650; resize?.() })
  expect(window.innerWidth).toBe(viewportWidth)
  expect(within(nav).queryByRole('link', { name: 'Queries' })).toBeNull()
  expect(within(nav).getByRole('link', { name: 'Site Health' })).toBeTruthy()
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toEqual([
    'Conversions', 'Local Presence', 'Queries', 'Backlinks', 'Report', 'Change History',
  ])
  act(() => { containerWidth = 1600; resize?.() })
  expect(within(nav).getByRole('link', { name: 'Queries' })).toBeTruthy()
  expect(within(nav).queryByRole('menu')).toBeNull()
})

test('the active primary section stays visible and Settings overflows on very narrow panels', async () => {
  containerWidth = 220
  const { nav } = await renderNav('queries')
  expect(within(nav).getAllByRole('link').map(item => item.textContent)).toEqual(['Queries'])
  expect(within(nav).getByRole('link', { name: 'Queries' }).getAttribute('aria-current')).toBe('page')
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getByRole('menuitem', { name: 'Settings' })).toBeTruthy()
})

test('the overflow menu supports keyboard navigation and restores focus on Escape', async () => {
  containerWidth = 650
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

test('overflow destinations and Settings retain measurement and drawer URL state', async () => {
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
  expect(within(nav).queryByRole('link', { name: 'Site Health' })).toBeNull()
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Site Health'])
  expect(within(nav).queryByText('Settings')).toBeNull()
  expect(within(nav).queryByText('Queries')).toBeNull()
})

test('an active low-frequency section remains identified inside More', async () => {
  const { nav } = await renderNav('report')
  const trigger = within(nav).getByRole('button', { name: 'More' })
  expect(trigger.classList.contains('project-subnav-link-active')).toBe(true)
  fireEvent.click(trigger)
  expect(within(nav).getByRole('menuitem', { name: 'Report' }).getAttribute('aria-current')).toBe('page')
  fireEvent.pointerDown(document.body)
  expect(within(nav).queryByRole('menu')).toBeNull()
})

test('a long active tab remains reachable at narrow widths and other tabs return when widened', async () => {
  containerWidth = 210
  widths.local = 280
  const { nav } = await renderNav('local')
  const active = within(nav).getByRole('link', { name: 'Local Presence' })
  expect(active.classList.contains('project-subnav-current')).toBe(true)
  expect(active.querySelector('.project-subnav-label')).toBeTruthy()
  expect(within(nav).getAllByRole('link')).toHaveLength(1)
  expect(within(nav).getByRole('button', { name: 'More' })).toBeTruthy()
  act(() => { containerWidth = 1600; resize?.() })
  expect(within(nav).getAllByRole('link')).toHaveLength(9)
  expect(within(nav).getByRole('link', { name: 'Local Presence' }).getAttribute('aria-current')).toBe('page')
})

test('font or label width changes remeasure the available tab budget', async () => {
  containerWidth = 650
  const { nav } = await renderNav()
  expect(within(nav).getByRole('link', { name: 'Site Health' })).toBeTruthy()
  act(() => { widths['search-console'] = 260; resize?.() })
  expect(within(nav).queryByRole('link', { name: 'Site Health' })).toBeNull()
  fireEvent.click(within(nav).getByRole('button', { name: 'More' }))
  expect(within(nav).getByRole('menuitem', { name: 'Site Health' })).toBeTruthy()
})

test('compiled navigation styles prevent wrapping without hiding the overflow menu', async () => {
  const stylesheet = resolve(import.meta.dirname, '../src/styles.css')
  const compiler = await compile(await readFile(stylesheet, 'utf8'), {
    from: stylesheet,
    base: dirname(stylesheet),
    loadStylesheet: async id => {
      const path = resolve(import.meta.dirname, '../node_modules/tailwindcss', id === 'tailwindcss' ? 'index.css' : `${id.slice('tailwindcss/'.length)}.css`)
      return { path, base: dirname(path), content: await readFile(path, 'utf8') }
    },
  })
  const css = compiler.build([])
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
