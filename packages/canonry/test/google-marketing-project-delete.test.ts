import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, type DatabaseClient } from '@canonry/canonry-db'
import type { CanonryConfig } from '../src/config.js'
import { loadConfig, loadConfigRaw, saveConfig, saveConfigPatch } from '../src/config.js'
import {
  getGoogleAdsConnection,
  upsertGoogleAdsConnection,
} from '../src/google-ads-config.js'
import {
  getGtmConnection,
  upsertGtmConnection,
} from '../src/gtm-config.js'
import { createServer } from '../src/server.js'

const previousConfigDir = process.env.CANONRY_CONFIG_DIR

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
  else process.env.CANONRY_CONFIG_DIR = previousConfigDir
})

it('purges both Google Marketing credentials on project delete before a name can be recreated', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-google-marketing-delete-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db: DatabaseClient = createClient(dbPath)
  migrate(db)
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const config: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: dbPath,
    apiKey,
    providers: {},
  }
  process.env.CANONRY_CONFIG_DIR = tmpDir
  saveConfig(config)
  const app = await createServer({ config, configPath: path.join(tmpDir, 'config.yaml'), db, logger: false })

  try {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/example',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        displayName: 'Example Hotel',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    expect(created.statusCode).toBe(201)
    const deletedProjectId = (JSON.parse(created.body) as { id: string }).id
    const now = '2026-08-14T12:00:00.000Z'
    upsertGoogleAdsConnection(config, {
      projectId: deletedProjectId,
      projectName: 'example',
      refreshToken: 'ads-refresh-private-fixture',
      createdAt: now,
      updatedAt: now,
    })
    upsertGtmConnection(config, {
      projectId: deletedProjectId,
      projectName: 'example',
      refreshToken: 'gtm-refresh-private-fixture',
      createdAt: now,
      updatedAt: now,
    })

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/example',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(deleted.statusCode).toBe(204)
    expect(getGoogleAdsConnection(config, deletedProjectId)).toBeUndefined()
    expect(getGtmConnection(config, deletedProjectId)).toBeUndefined()

    const recreated = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/example',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        displayName: 'Example Hotel',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    expect(recreated.statusCode).toBe(201)
    const recreatedProjectId = (JSON.parse(recreated.body) as { id: string }).id
    expect(recreatedProjectId).not.toBe(deletedProjectId)
    expect(getGoogleAdsConnection(config, recreatedProjectId)).toBeUndefined()
    expect(getGtmConnection(config, recreatedProjectId)).toBeUndefined()

    const persisted = loadConfigRaw()
    expect(persisted?.googleAds?.connections ?? []).toEqual([])
    expect(persisted?.gtm?.connections ?? []).toEqual([])
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

it('aborts project delete and restores Google Marketing credentials when config persistence fails', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-google-marketing-delete-save-failure-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db: DatabaseClient = createClient(dbPath)
  migrate(db)
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const config: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: dbPath,
    apiKey,
    providers: {},
  }
  process.env.CANONRY_CONFIG_DIR = tmpDir
  saveConfig(config)
  const app = await createServer({ config, configPath: path.join(tmpDir, 'config.yaml'), db, logger: false })

  try {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/example',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        displayName: 'Example Hotel',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    expect(created.statusCode).toBe(201)
    const projectId = (JSON.parse(created.body) as { id: string }).id
    const now = '2026-08-14T12:00:00.000Z'
    upsertGoogleAdsConnection(config, {
      projectId,
      projectName: 'example',
      refreshToken: 'ads-refresh-private-fixture',
      createdAt: now,
      updatedAt: now,
    })
    upsertGtmConnection(config, {
      projectId,
      projectName: 'example',
      refreshToken: 'gtm-refresh-private-fixture',
      createdAt: now,
      updatedAt: now,
    })
    saveConfigPatch({ googleAds: config.googleAds, gtm: config.gtm })

    // The config write fails once, as a full or read-only disk would.
    const renameFailure = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated config write failure')
    })
    let failedDelete: Awaited<ReturnType<typeof app.inject>>
    try {
      failedDelete = await app.inject({
        method: 'DELETE',
        url: '/api/v1/projects/example',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      expect(renameFailure.mock.calls[0]?.[1]).toBe(path.join(tmpDir, 'config.yaml'))
    } finally {
      renameFailure.mockRestore()
    }
    expect(failedDelete.statusCode).toBe(500)
    expect(db.select().from(projects).where(eq(projects.id, projectId)).get()).toBeDefined()
    expect(getGoogleAdsConnection(config, projectId)?.refreshToken).toBe('ads-refresh-private-fixture')
    expect(getGtmConnection(config, projectId)?.refreshToken).toBe('gtm-refresh-private-fixture')

    const persistedAfterFailure = loadConfigRaw()
    expect(persistedAfterFailure?.googleAds?.connections?.[0]?.refreshToken).toBe('ads-refresh-private-fixture')
    expect(persistedAfterFailure?.gtm?.connections?.[0]?.refreshToken).toBe('gtm-refresh-private-fixture')

    const retriedDelete = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/example',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(retriedDelete.statusCode).toBe(204)
    expect(getGoogleAdsConnection(config, projectId)).toBeUndefined()
    expect(getGtmConnection(config, projectId)).toBeUndefined()
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

it('reconciles project-ID Google Marketing credentials left on disk by a crash after project deletion', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-google-marketing-orphan-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db: DatabaseClient = createClient(dbPath)
  migrate(db)
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const config: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: dbPath,
    apiKey,
    providers: {},
  }
  process.env.CANONRY_CONFIG_DIR = tmpDir
  saveConfig(config)
  const app = await createServer({ config, configPath: path.join(tmpDir, 'config.yaml'), db, logger: false })
  let restarted: Awaited<ReturnType<typeof createServer>> | undefined

  try {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/example',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        displayName: 'Example Hotel',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    expect(created.statusCode).toBe(201)
    const deletedProjectId = (JSON.parse(created.body) as { id: string }).id
    const now = '2026-08-14T12:00:00.000Z'
    upsertGoogleAdsConnection(config, {
      projectId: deletedProjectId,
      projectName: 'example',
      refreshToken: 'ads-refresh-private-fixture',
      createdAt: now,
      updatedAt: now,
    })
    upsertGtmConnection(config, {
      projectId: deletedProjectId,
      projectName: 'example',
      refreshToken: 'gtm-refresh-private-fixture',
      createdAt: now,
      updatedAt: now,
    })
    saveConfigPatch({ googleAds: config.googleAds, gtm: config.gtm })

    // Emulate a legacy or externally interrupted delete that removed the DB
    // project while leaving private config credentials behind. Startup
    // reconciliation remains the recovery net; it is not a cross-store
    // transaction guarantee.
    db.delete(projects).where(eq(projects.id, deletedProjectId)).run()
    const restartedConfig = loadConfig()
    restarted = await createServer({ config: restartedConfig, configPath: path.join(tmpDir, 'config.yaml'), db, logger: false })

    expect(getGoogleAdsConnection(restartedConfig, deletedProjectId)).toBeUndefined()
    expect(getGtmConnection(restartedConfig, deletedProjectId)).toBeUndefined()
    const persisted = loadConfigRaw()
    expect(persisted?.googleAds?.connections ?? []).toEqual([])
    expect(persisted?.gtm?.connections ?? []).toEqual([])
  } finally {
    await restarted?.close()
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
