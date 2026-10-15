import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, expect, it } from 'vitest'
import { createClient, migrate, projects } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

const NOW = '2026-08-01T00:00:00.000Z'

/**
 * Slice 1 registered these routes and left the bodies to the slices that own
 * each module. Those slices have landed, so nothing here answers 501 any more.
 *
 * What the file still pins is what it was written to catch, now stated in both
 * directions: every path is mounted, so a route that quietly failed to register
 * cannot hide behind a handler that was never called; and none of them has
 * regressed to a stub. A route that came back as 501 would mean a slice was
 * reverted or lost in an integration, which is exactly the failure a squashed
 * merge makes easy to miss.
 */
const DRAFT_ROUTES = [
  ['GET', '/measurement-setup'],
  ['GET', '/measurement-plan/draft'],
  ['GET', '/measurement-plan/draft/targets'],
  ['GET', '/measurement-plan/draft/assignments'],
  ['GET', '/measurement-plan/draft/groups'],
  ['POST', '/measurement-plan/draft/actions/create'],
  ['POST', '/measurement-plan/draft/actions/upsert-target'],
  ['POST', '/measurement-plan/draft/actions/rename-target'],
  ['POST', '/measurement-plan/draft/actions/merge-targets'],
  ['POST', '/measurement-plan/draft/actions/exclude-target'],
  ['POST', '/measurement-plan/draft/actions/rebind-target'],
  ['POST', '/measurement-plan/draft/actions/apply-assignments'],
  ['POST', '/measurement-plan/draft/actions/remove-assignment'],
  ['POST', '/measurement-plan/draft/actions/clear-assignments'],
  ['POST', '/measurement-plan/draft/actions/classify-assignments'],
  ['POST', '/measurement-plan/draft/actions/upsert-group'],
  ['POST', '/measurement-plan/draft/actions/remove-group'],
  ['POST', '/measurement-plan/draft/actions/upsert-competitor'],
  ['POST', '/measurement-plan/draft/actions/remove-competitor'],
  ['POST', '/measurement-plan/draft/actions/compile-preview'],
  ['POST', '/measurement-plan/draft/actions/diff-preview'],
  ['POST', '/measurement-plan/draft/actions/publish'],
  ['POST', '/measurement-plan/draft/actions/discard'],
  ['POST', '/measurement-plan/actions/deactivate'],
  ['GET', '/measurement-query-sets'],
  ['GET', '/measurement-query-sets/qs-1'],
  ['PUT', '/measurement-query-sets/qs-1'],
  ['DELETE', '/measurement-query-sets/qs-1'],
  ['GET', '/measurement-query-templates'],
  ['PUT', '/measurement-query-templates/tpl-1'],
  ['DELETE', '/measurement-query-templates/tpl-1'],
  ['POST', '/measurement-query-templates/tpl-1/apply'],
] as const

const DISCOVERY_ROUTES = [
  ['POST', '/measurement-plan/draft/actions/import-sitemap'],
  ['POST', '/measurement-plan/draft/actions/apply-sitemap-selection'],
] as const

const OVERVIEW_ROUTES = [
  ['GET', '/measurement-overview?scope=all'],
] as const

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-v2-stubs-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'prj_1',
    name: 'northstar',
    displayName: 'Northstar',
    canonicalDomain: 'northstar.example',
    country: 'US',
    language: 'en',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true } satisfies ApiRoutesOptions)
  return { app, tmpDir }
}

const cleanups: Array<() => void> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) fn()
})

it.each([...DRAFT_ROUTES, ...DISCOVERY_ROUTES, ...OVERVIEW_ROUTES])(
  '%s %s is mounted and is not a stub',
  async (method, route) => {
    const { app, tmpDir } = buildApp()
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

    const response = await app.inject({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: `/api/v1/projects/northstar${route}`,
      ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
    })

    // The project has no draft, no plan and an empty payload, so each route
    // answers either a real success or a real refusal. Which one is each
    // slice's own business and is asserted in that slice's tests; what matters
    // here is only that a handler ran.
    //
    // A plain "not 404" cannot say that, because several of these answer 404
    // correctly when no draft exists. The discriminator is the body: a mounted
    // route either succeeds or produces a coded domain error, where an unrouted
    // one produces Fastify's default shape with a bare `error` string.
    const body = response.json() as { error?: unknown }
    const code = typeof body.error === 'object' && body.error !== null
      ? (body.error as { code?: unknown }).code
      : undefined

    if (response.statusCode >= 400) {
      expect(
        typeof code,
        `${method} ${route} was not mounted (${response.statusCode}: ${JSON.stringify(body).slice(0, 120)})`,
      ).toBe('string')
      expect(code, `${method} ${route} is still a stub`).not.toBe('NOT_IMPLEMENTED')
    }
    expect(response.statusCode, `${method} ${route} crashed`).toBeLessThan(500)
    await app.close()
  },
)
