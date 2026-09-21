import { afterEach, expect, test } from 'vitest'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render } from '@testing-library/react'

import { NextSteps, buildNextSteps } from '../src/components/shared/NextSteps.js'

afterEach(cleanup)

async function renderNextSteps(projectName = 'citypoint') {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <NextSteps projectName={projectName} />
        <Outlet />
      </>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: 'projects/$projectName/search-console', component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: 'projects/$projectName/activity', component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: 'projects/$projectName/settings', component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: 'projects/$projectName/local', component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return render(<RouterProvider router={router} />).container
}

/** The action link's accessible name: its visible verb plus its sr-only row. */
function linkNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('a')].map(a => a.textContent?.replace(/\s+/g, ' ').trim() ?? '')
}

test('every next step points somewhere that exists', () => {
  // A dead link here is worse than no link: this is the one screen an operator
  // trusts to tell them what the product can do, so each destination is a
  // surface that actually renders a connect prompt or its data.
  const steps = buildNextSteps()
  expect(steps).toHaveLength(6)
  for (const step of steps) {
    expect(Boolean(step.to) !== Boolean(step.href)).toBe(true)
    // DESIGN.md caps supporting copy at roughly one 90-character line.
    expect(step.detail.length).toBeLessThanOrEqual(90)
  }
  expect(steps.map(step => step.to ?? step.href)).toEqual([
    '/projects/$projectName/search-console',
    '/projects/$projectName/activity',
    '/projects/$projectName/settings',
    '/projects/$projectName/settings',
    '/projects/$projectName/local',
    'https://github.com/Canonry/canonry/blob/main/docs/mcp.md',
  ])
})

test('a project name with url-unsafe characters still routes', async () => {
  // Project names are free text up to 120 characters, not slugs, so the router
  // has to do the encoding rather than a hand-built path.
  const container = await renderNextSteps('my project/v2')
  expect(container.querySelector('a')?.getAttribute('href'))
    .toBe('/projects/my%20project%2Fv2/search-console')
})

test('each row reads as label, value, action', async () => {
  const container = await renderNextSteps()
  const rows = [...container.querySelectorAll('li')]
  expect(rows).toHaveLength(6)
  expect(rows[0]?.textContent).toContain('Search Console')
  expect(rows[0]?.textContent).toContain('Compare answer engines with the queries you already rank for.')

  // Each action link carries its row name in sr-only text, so "Set up" is not
  // one of three identical links when read out of context. Two rows share both
  // the destination and the verb, which is exactly when this matters.
  expect(linkNames(container)).toEqual([
    'Connect Search Console',
    'Connect Google Analytics',
    'Set up Scheduled sweeps',
    'Set up Notifications',
    'Open Local presence',
    'Docs Your agent',
  ])
})

test('one heading, so it cannot outrank the result it sits under', async () => {
  const container = await renderNextSteps()
  const headings = [...container.querySelectorAll('h1, h2, h3, h4')]
  expect(headings).toHaveLength(1)
  expect(headings[0]?.tagName).toBe('H2')
  expect(headings[0]?.textContent).toBe('What else this project can do')
})

test('the agent link leaves the dashboard safely', async () => {
  const container = await renderNextSteps()
  const docs = [...container.querySelectorAll('a')].at(-1)!
  expect(docs.getAttribute('href')).toBe('https://github.com/Canonry/canonry/blob/main/docs/mcp.md')
  expect(docs.getAttribute('target')).toBe('_blank')
  expect(docs.getAttribute('rel')).toBe('noreferrer')
})
