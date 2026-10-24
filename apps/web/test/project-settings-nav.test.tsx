import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'

import { ProjectSettingsLayout, type ProjectSettingsEntry } from '../src/components/project/settings/ProjectSettingsNav.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// Project Settings is one stacked page. Its jump list names the sections on the page, takes the reader to
// one, and says which one the page is on. The list has no route key: a section is the URL's hash.
const SECTIONS: ProjectSettingsEntry[] = [
  { id: 'settings-general', label: 'General', content: <section><h2>Project settings</h2><button type="button">Edit settings</button></section> },
  { id: 'settings-schedule', label: 'Schedule', content: <section><h2>Scheduled checks</h2><button type="button">Set schedule</button></section> },
  { id: 'settings-notifications', label: 'Notifications', content: <section><h2>Notifications</h2><button type="button">Add webhook</button></section> },
]

async function renderSettings({ entry = '/projects/acme/settings?measurementProvider=openai', sections = SECTIONS, nav = true } = {}) {
  const rootRoute = createRootRoute({ component: () => <><ProjectSettingsLayout sections={sections} nav={nav} /><Outlet /></> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: '/projects/$projectName/settings', component: () => null })]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}

const list = () => screen.getByRole('navigation', { name: 'Settings sections' })
const links = () => within(list()).getAllByRole('link')
const picker = () => within(list()).getByRole<HTMLSelectElement>('combobox', { name: 'Settings section' })
/** The entries marked as where the page is, in both forms of the list: the link and the select's value. */
const current = () => ({ link: links().filter(link => link.hasAttribute('aria-current')).map(link => [link.textContent, link.getAttribute('aria-current')]), select: picker().value })
const anchor = (id: string) => document.getElementById(id)!

/** jsdom has no layout: give each section a top edge, as a scrolled page would. */
function layOut(tops: Record<string, number>, page: { scrollY: number; innerHeight: number; scrollHeight: number }) {
  for (const [id, top] of Object.entries(tops)) vi.spyOn(anchor(id), 'getBoundingClientRect').mockReturnValue({ top } as DOMRect)
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(page.scrollY)
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(page.innerHeight)
  vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(page.scrollHeight)
}

test('names the sections on the page, in order, as links and as one select', async () => {
  await renderSettings()
  // Each link is this page with the section as its hash, so it works under any base path and keeps the URL's selection.
  expect(links().map(link => [link.textContent, link.getAttribute('href')])).toEqual([
    ['General', '/projects/acme/settings?measurementProvider=openai#settings-general'],
    ['Schedule', '/projects/acme/settings?measurementProvider=openai#settings-schedule'],
    ['Notifications', '/projects/acme/settings?measurementProvider=openai#settings-notifications'],
  ])
  expect([...picker().options].map(option => [option.textContent, option.value])).toEqual([
    ['General', 'settings-general'], ['Schedule', 'settings-schedule'], ['Notifications', 'settings-notifications'],
  ])
  // Every entry has its section on the page, holding that section and nothing else.
  expect(SECTIONS.map(section => within(anchor(section.id)).getByRole('heading').textContent)).toEqual(['Project settings', 'Scheduled checks', 'Notifications'])
  // The page opens on its first section, and exactly one entry is marked.
  expect(current()).toEqual({ link: [['General', 'location']], select: 'settings-general' })
})

test('a link jumps to its section: the page scrolls there, the keys go on from it and the URL names it', async () => {
  const router = await renderSettings()
  const scrolled = vi.fn()
  anchor('settings-schedule').scrollIntoView = scrolled
  const entries = router.history.length

  fireEvent.click(within(list()).getByRole('link', { name: 'Schedule' }))
  expect(scrolled).toHaveBeenCalled()
  expect(document.activeElement).toBe(anchor('settings-schedule'))
  expect(current()).toEqual({ link: [['Schedule', 'location']], select: 'settings-schedule' })
  await waitFor(() => expect(router.state.location.hash).toBe('settings-schedule'))
  // Still Settings, with the selection it had: the jump is not a route change.
  expect(router.state.location.pathname).toBe('/projects/acme/settings')
  expect(router.state.location.search).toEqual({ measurementProvider: 'openai' })
  // A jump takes the place of the entry it left, so Back leaves Settings in one step.
  expect(router.history.length).toBe(entries)
})

test.each([
  ['Ctrl', { ctrlKey: true }],
  ['Cmd', { metaKey: true }],
  ['Shift', { shiftKey: true }],
  ['Alt', { altKey: true }],
  ['the middle button', { button: 1 }],
])('a click with %s opens the link elsewhere and leaves this page where it is', async (_name, how) => {
  const router = await renderSettings()
  const scrolled = vi.fn()
  anchor('settings-schedule').scrollIntoView = scrolled
  // jsdom has no other tab to open: the click's own default is stopped once it has passed the link.
  document.addEventListener('click', event => event.preventDefault(), { once: true })

  fireEvent.click(within(list()).getByRole('link', { name: 'Schedule' }), how)
  expect(scrolled).not.toHaveBeenCalled()
  expect(document.activeElement).not.toBe(anchor('settings-schedule'))
  expect(current()).toEqual({ link: [['General', 'location']], select: 'settings-general' })
  expect(router.state.location.hash).toBe('')
})

test('the select jumps the same way', async () => {
  const router = await renderSettings()
  const scrolled = vi.fn()
  anchor('settings-notifications').scrollIntoView = scrolled
  const entries = router.history.length

  fireEvent.change(picker(), { target: { value: 'settings-notifications' } })
  expect(scrolled).toHaveBeenCalled()
  expect(document.activeElement).toBe(anchor('settings-notifications'))
  expect(current()).toEqual({ link: [['Notifications', 'location']], select: 'settings-notifications' })
  await waitFor(() => expect(router.state.location.hash).toBe('settings-notifications'))
  expect(router.state.location.search).toEqual({ measurementProvider: 'openai' })
  expect(router.history.length).toBe(entries)
})

test('a URL that names a section opens on it', async () => {
  // jsdom has no layout and no scrollIntoView: stand one in for every element, for this test.
  const scrolled: Element[] = []
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value(this: Element) { scrolled.push(this) } })
  onTestFinished(() => { Reflect.deleteProperty(Element.prototype, 'scrollIntoView') })

  await renderSettings({ entry: '/projects/acme/settings#settings-notifications' })
  expect(current()).toEqual({ link: [['Notifications', 'location']], select: 'settings-notifications' })
  expect(scrolled).toContain(anchor('settings-notifications'))
})

test('a page that opens on a section stays on it while the sections above load, until the reader takes over', async () => {
  const scrolled: Element[] = []
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value(this: Element) { scrolled.push(this) } })
  onTestFinished(() => { Reflect.deleteProperty(Element.prototype, 'scrollIntoView') })
  // jsdom has no ResizeObserver. This one reports when the test says the page changed size.
  const observers: { report: () => void; live: boolean }[] = []
  vi.stubGlobal('ResizeObserver', class {
    private readonly entry: { report: () => void; live: boolean }
    constructor(report: () => void) { this.entry = { report, live: false }; observers.push(this.entry) }
    observe() { this.entry.live = true }
    disconnect() { this.entry.live = false }
  })
  onTestFinished(() => { vi.unstubAllGlobals() })
  const pageResized = () => act(() => { for (const observer of observers) if (observer.live) observer.report() })

  await renderSettings({ entry: '/projects/acme/settings#settings-notifications' })
  const landings = () => scrolled.filter(element => element === anchor('settings-notifications')).length
  // The observer's first report is the size as it stands: nothing moved, so nothing is scrolled again.
  pageResized()
  const opened = landings()
  expect(opened).toBeGreaterThan(0)

  // A section above lands and pushes Notifications down: the page goes back to it.
  pageResized()
  expect(landings()).toBe(opened + 1)

  // The reader scrolls. From here the page is theirs.
  fireEvent.wheel(window)
  pageResized()
  expect(landings()).toBe(opened + 1)
})

test('a page that opens on a section lets go of it after three seconds', async () => {
  const scrolled: Element[] = []
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value(this: Element) { scrolled.push(this) } })
  onTestFinished(() => { Reflect.deleteProperty(Element.prototype, 'scrollIntoView') })
  const observers: { report: () => void; live: boolean }[] = []
  vi.stubGlobal('ResizeObserver', class {
    private readonly entry: { report: () => void; live: boolean }
    constructor(report: () => void) { this.entry = { report, live: false }; observers.push(this.entry) }
    observe() { this.entry.live = true }
    disconnect() { this.entry.live = false }
  })
  onTestFinished(() => { vi.unstubAllGlobals() })
  const pageResized = () => act(() => { for (const observer of observers) if (observer.live) observer.report() })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  await renderSettings({ entry: '/projects/acme/settings#settings-notifications' })
  const landings = () => scrolled.filter(element => element === anchor('settings-notifications')).length
  pageResized()
  const opened = landings()

  // Just short of three seconds the page still goes back to its section.
  vi.advanceTimersByTime(2900)
  pageResized()
  expect(landings()).toBe(opened + 1)

  // After them a late change in the page's size moves nothing: the reader is not pulled back.
  vi.advanceTimersByTime(100)
  pageResized()
  expect(landings()).toBe(opened + 1)
})

test('a hash that is no section of this page is left alone', async () => {
  await renderSettings({ entry: '/projects/acme/settings#provider-openai' })
  expect(current()).toEqual({ link: [['General', 'location']], select: 'settings-general' })
})

test('the mark follows the page as it scrolls', async () => {
  await renderSettings()
  // Schedule has reached the top; Notifications is still below it.
  layOut({ 'settings-general': -900, 'settings-schedule': 0, 'settings-notifications': 420 }, { scrollY: 900, innerHeight: 800, scrollHeight: 2400 })
  await act(async () => {
    fireEvent.scroll(window)
    await new Promise(resolve => requestAnimationFrame(resolve))
  })
  expect(current()).toEqual({ link: [['Schedule', 'location']], select: 'settings-schedule' })

  // At the end of the page the last section never reaches the top. It is still where the page is.
  layOut({ 'settings-general': -1600, 'settings-schedule': -700, 'settings-notifications': 300 }, { scrollY: 1600, innerHeight: 800, scrollHeight: 2400 })
  await act(async () => {
    fireEvent.scroll(window)
    await new Promise(resolve => requestAnimationFrame(resolve))
  })
  expect(current()).toEqual({ link: [['Notifications', 'location']], select: 'settings-notifications' })
})

test('the scroll of a jump does not hand the mark to a section it passes', async () => {
  await renderSettings()
  anchor('settings-notifications').scrollIntoView = () => {}
  fireEvent.click(within(list()).getByRole('link', { name: 'Notifications' }))
  // Mid-jump the page is passing Schedule.
  layOut({ 'settings-general': -900, 'settings-schedule': 0, 'settings-notifications': 420 }, { scrollY: 900, innerHeight: 800, scrollHeight: 4000 })
  await act(async () => {
    fireEvent.scroll(window)
    await new Promise(resolve => requestAnimationFrame(resolve))
  })
  expect(current()).toEqual({ link: [['Notifications', 'location']], select: 'settings-notifications' })
})

test('once the reader scrolls, the mark follows the page again, also right after a jump', async () => {
  await renderSettings()
  anchor('settings-notifications').scrollIntoView = () => {}
  fireEvent.click(within(list()).getByRole('link', { name: 'Notifications' }))
  // The reader turns the wheel before the jump has settled, and the page ends on Schedule.
  layOut({ 'settings-general': -900, 'settings-schedule': 0, 'settings-notifications': 420 }, { scrollY: 900, innerHeight: 800, scrollHeight: 4000 })
  fireEvent.wheel(window)
  await act(async () => {
    fireEvent.scroll(window)
    await new Promise(resolve => requestAnimationFrame(resolve))
  })
  expect(current()).toEqual({ link: [['Schedule', 'location']], select: 'settings-schedule' })
})

test('without the list the sections render as they are', async () => {
  await renderSettings({ nav: false })
  expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull()
  expect(SECTIONS.map(section => document.getElementById(section.id))).toEqual([null, null, null])
  expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Project settings', 'Scheduled checks', 'Notifications'])
  // No wrapper stands between the sections: they are siblings, as they were before the list.
  expect(new Set(screen.getAllByRole('heading').map(heading => heading.closest('section')!.parentElement)).size).toBe(1)
})
