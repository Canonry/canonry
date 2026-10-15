import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, trafficSources } from '@canonry/canonry-db'
import { releaseTrafficSyncLease, tryClaimTrafficSyncLease } from '../src/traffic-sync-lease.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function createSource() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-traffic-sync-lease-'))
  directories.push(directory)
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  const now = '2026-08-11T12:00:00.000Z'
  const projectId = crypto.randomUUID()
  const sourceId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: `lease-${projectId}`,
    displayName: 'Lease test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: [],
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(trafficSources).values({
    id: sourceId,
    projectId,
    sourceType: 'cloudflare',
    displayName: 'Cloudflare',
    status: 'connected',
    configJson: { deliveryMode: 'queue-pull' },
    createdAt: now,
    updatedAt: now,
  }).run()
  return { db, sourceId }
}

describe('traffic sync lease', () => {
  it('claims atomically, renews for its owner, recovers stale leases, and releases owner-only', () => {
    const { db, sourceId } = createSource()
    const initialNow = '2026-08-11T12:00:00.000Z'
    const originalUpdatedAt = db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!.updatedAt

    expect(tryClaimTrafficSyncLease({
      db, sourceId, owner: 'worker-a', now: initialNow, ttlMs: 60_000,
    })).toBe(true)

    let source = db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
    expect(source.syncLeaseOwner).toBe('worker-a')
    expect(source.syncLeaseExpiresAt).toBe('2026-08-11T12:01:00.000Z')
    expect(source.updatedAt).toBe(originalUpdatedAt)

    expect(tryClaimTrafficSyncLease({
      db, sourceId, owner: 'worker-b', now: '2026-08-11T12:00:01.000Z', ttlMs: 60_000,
    })).toBe(false)

    expect(tryClaimTrafficSyncLease({
      db, sourceId, owner: 'worker-a', now: '2026-08-11T12:00:10.000Z', ttlMs: 120_000,
    })).toBe(true)
    source = db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
    expect(source.syncLeaseExpiresAt).toBe('2026-08-11T12:02:10.000Z')
    expect(source.updatedAt).toBe(originalUpdatedAt)

    expect(tryClaimTrafficSyncLease({
      db, sourceId, owner: 'worker-b', now: '2026-08-11T12:02:10.000Z', ttlMs: 60_000,
    })).toBe(true)
    expect(releaseTrafficSyncLease({
      db, sourceId, owner: 'worker-a', now: '2026-08-11T12:02:11.000Z',
    })).toBe(false)
    expect(releaseTrafficSyncLease({
      db, sourceId, owner: 'worker-b', now: '2026-08-11T12:02:11.000Z',
    })).toBe(true)
    source = db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()!
    expect(source.syncLeaseOwner).toBeNull()
    expect(source.syncLeaseExpiresAt).toBeNull()
    expect(source.updatedAt).toBe(originalUpdatedAt)
  })

  it('does not claim a missing source', () => {
    const { db } = createSource()
    expect(tryClaimTrafficSyncLease({
      db,
      sourceId: 'missing',
      owner: 'worker-a',
      now: '2026-08-11T12:00:00.000Z',
      ttlMs: 60_000,
    })).toBe(false)
  })
})
