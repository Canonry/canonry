import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects } from '@canonry/canonry-db'
import { activePlanEntityRegistry, planEntityRegistry } from '../src/site-audit-entity-registry.js'
import { entityPlan, storePlanRevision, storeV1Plan } from './site-audit-entity-plan-fixture.js'

const NOW = '2026-11-10T00:00:00.000Z'

describe('planEntityRegistry', () => {
  it('lists each Property with its names and the pages that belong to it', () => {
    expect(planEntityRegistry(entityPlan())).toEqual({ entities: [
      {
        key: 'harbor-point',
        // The label first, then aliases and identity aliases, each once.
        names: ['Harbor Point', 'Harbor Point Apartments', 'Harbor Point Austin'],
        urlMatchers: [
          { host: 'example.com', pathPrefix: '/apartments/harbor-point' },
          // A host of its own: every page on it.
          { host: 'harborpoint.example.com', pathPrefix: '/' },
        ],
      },
      // An exact page owns the pages under it too.
      { key: 'ridge-view', names: ['Ridge View'], urlMatchers: [{ host: 'example.com', pathPrefix: '/apartments/ridge-view/' }] },
    ] })
  })

  it('has no registry for a plan without Properties', () => {
    expect(planEntityRegistry(entityPlan({ targets: [] }))).toBeNull()
  })
})

describe('activePlanEntityRegistry', () => {
  let db: ReturnType<typeof createClient>
  let projectId: string

  beforeEach(() => {
    db = createClient(':memory:')
    migrate(db)
    projectId = crypto.randomUUID()
    db.insert(projects).values({ id: projectId, name: 'homes', displayName: 'Homes', canonicalDomain: 'example.com', country: 'US', language: 'en',
      providers: [], locations: [], createdAt: NOW, updatedAt: NOW }).run()
  })

  afterEach(() => { db.$client.close() })

  it('reads the active revision, not the newest one', () => {
    storePlanRevision(db, projectId, entityPlan(), 7)
    storePlanRevision(db, projectId, entityPlan({ targets: entityPlan().targets.slice(0, 1) }), 8, false)
    const active = activePlanEntityRegistry(db, projectId)
    expect(active?.planRevision).toBe(7)
    expect(active?.registry.entities.map(entity => entity.key)).toEqual(['harbor-point', 'ridge-view'])
  })

  it('has no registry without a plan, with an older plan, or with a plan that has no Properties', () => {
    expect(activePlanEntityRegistry(db, projectId)).toBeNull()
    storeV1Plan(db, projectId)
    expect(activePlanEntityRegistry(db, projectId)).toBeNull()
    storePlanRevision(db, projectId, entityPlan({ targets: [] }), 2)
    expect(activePlanEntityRegistry(db, projectId)).toBeNull()
  })
})
