import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, projects, gbpLocations, type DatabaseClient } from '@ainyc/canonry-db'
import { PLACES_CHECK_BY_ID } from '../src/doctor/checks/places.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'
import type { GoogleConnectionStore } from '../src/google.js'

const check = PLACES_CHECK_BY_ID['gbp.places.api-key']!
const project: ProjectInfo = { id: 'p1', name: 'hotels', canonicalDomain: 'hotels.example.com', displayName: 'Hotels' }

let tmpDir: string
let db: DatabaseClient

function seedLocation(opts: { locationName: string; selected: boolean; placeId: string | null }) {
  const now = new Date().toISOString()
  db.insert(gbpLocations).values({
    id: crypto.randomUUID(),
    projectId: project.id,
    accountName: 'accounts/1',
    locationName: opts.locationName,
    displayName: opts.locationName,
    placeId: opts.placeId,
    mapsUri: null,
    selected: opts.selected,
    createdAt: now,
    updatedAt: now,
  }).run()
}

function gbpStore(connected = true): GoogleConnectionStore {
  const conn = connected
    ? { domain: project.canonicalDomain, connectionType: 'gbp' as const, createdAt: 'x', updatedAt: 'x' }
    : undefined
  return {
    listConnections: () => (conn ? [conn] : []),
    getConnection: () => conn,
    upsertConnection: (r) => r,
    updateConnection: () => conn,
    deleteConnection: () => true,
  }
}

function ctx(overrides: Partial<DoctorContext>): DoctorContext {
  return {
    db,
    project,
    googleConnectionStore: gbpStore(true),
    getPlacesConfig: () => ({ apiKey: 'KEY', tier: 'atmosphere', refreshIntervalDays: 7 }),
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-places-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: project.id, name: project.name, displayName: project.displayName, canonicalDomain: project.canonicalDomain,
    country: 'US', language: 'en', ownedDomains: '[]', tags: '[]', labels: '{}', providers: '[]', locations: '[]',
    defaultLocation: null, autoExtractBacklinks: 0, configSource: 'cli', configRevision: 1, createdAt: now, updatedAt: now,
  }).run()
})
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

describe('gbp.places.api-key', () => {
  it('skipped when no project context', async () => {
    const r = await check.run(ctx({ project: null }))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('gbp.places.no-project')
  })

  it('skipped when the places config getter is not wired (cloud)', async () => {
    const r = await check.run(ctx({ getPlacesConfig: undefined }))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('gbp.places.config-unavailable')
  })

  it('skipped when tier is off', async () => {
    const r = await check.run(ctx({ getPlacesConfig: () => ({ tier: 'off', refreshIntervalDays: 7 }) }))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('gbp.places.disabled')
  })

  it('skipped when GBP is not connected (Places only matters with GBP)', async () => {
    const r = await check.run(ctx({ googleConnectionStore: gbpStore(false) }))
    expect(r.status).toBe('skipped')
    expect(r.code).toBe('gbp.places.no-gbp-connection')
  })

  it('warns when GBP is connected but no Places API key is set', async () => {
    seedLocation({ locationName: 'locations/1', selected: true, placeId: 'ChIJabc' })
    const r = await check.run(ctx({ getPlacesConfig: () => ({ tier: 'atmosphere', refreshIntervalDays: 7 }) }))
    expect(r.status).toBe('warn')
    expect(r.code).toBe('gbp.places.api-key-missing')
  })

  it('ok when key present and selected locations carry place ids', async () => {
    seedLocation({ locationName: 'locations/1', selected: true, placeId: 'ChIJabc' })
    seedLocation({ locationName: 'locations/2', selected: true, placeId: null })
    seedLocation({ locationName: 'locations/3', selected: false, placeId: 'ChIJxyz' }) // deselected — ignored
    const r = await check.run(ctx({}))
    expect(r.status).toBe('ok')
    expect(r.code).toBe('gbp.places.ready')
    expect(r.details).toMatchObject({ tier: 'atmosphere', refreshIntervalDays: 7, selectedLocations: 2, locationsWithPlaceId: 1 })
  })

  it('warns when key present but NO selected location has a place id (re-discover needed)', async () => {
    seedLocation({ locationName: 'locations/1', selected: true, placeId: null })
    const r = await check.run(ctx({}))
    expect(r.status).toBe('warn')
    expect(r.code).toBe('gbp.places.no-place-ids')
  })

  it('ok with zero counts when key present but no locations discovered yet', async () => {
    const r = await check.run(ctx({}))
    expect(r.status).toBe('ok')
    expect(r.code).toBe('gbp.places.ready')
    expect(r.details).toMatchObject({ selectedLocations: 0, locationsWithPlaceId: 0 })
  })
})
