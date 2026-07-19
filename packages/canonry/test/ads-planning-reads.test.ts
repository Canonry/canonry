import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiKeys, createClient, migrate, projects } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import type { CanonryConfig } from '../src/config.js'

const NOW = '2026-07-19T00:00:00.000Z'

describe('ads planning reads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('serves partial conversion rows without leaking unconfirmed provider fields', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ads-planning-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)

    const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: 'key_1',
      name: 'test',
      keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
      keyPrefix: rawKey.slice(0, 9),
      scopes: ['*'],
      createdAt: NOW,
    }).run()
    db.insert(projects).values({
      id: 'project_1',
      name: 'acme',
      displayName: 'Acme',
      canonicalDomain: 'acme.example',
      country: 'US',
      language: 'en',
      createdAt: NOW,
      updatedAt: NOW,
    }).run()

    const config: CanonryConfig = {
      apiUrl: 'http://localhost:4100',
      database: dbPath,
      apiKey: rawKey,
      openaiAds: {
        connections: [
          {
            projectName: 'acme',
            apiKey: 'sk-ads-test',
            adAccountId: 'adacct_1',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    }

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      let id: string
      if (url.endsWith('/conversions/pixels')) id = 'pixel_partial'
      else if (url.endsWith('/conversions/event_settings')) id = 'event_partial'
      else throw new Error(`Unexpected OpenAI Ads request: ${url}`)
      const data = [{ id, secretBearingExtra: 'sk-do-not-return' }]
      return new Response(JSON.stringify({
        object: 'list',
        data,
        first_id: data[0]?.id ?? null,
        last_id: data[0]?.id ?? null,
        has_more: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const app = await createServer({ config, db, logger: false })
    try {
      const headers = { authorization: `Bearer ${rawKey}` }
      const pixels = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/acme/ads/conversions/pixels',
        headers,
      })
      const eventSettings = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/acme/ads/conversions/event-settings',
        headers,
      })

      expect(pixels.statusCode).toBe(200)
      expect(JSON.parse(pixels.body)).toEqual({ pixels: [{ id: 'pixel_partial' }] })
      expect(eventSettings.statusCode).toBe(200)
      expect(JSON.parse(eventSettings.body)).toEqual({ eventSettings: [{ id: 'event_partial' }] })
      expect(pixels.body).not.toContain('sk-do-not-return')
      expect(eventSettings.body).not.toContain('sk-do-not-return')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
