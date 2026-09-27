import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  createClient,
  gbpReviewSettings,
  migrate,
  projects,
  readAllNegativeReviewMaxStars,
  readNegativeReviewMaxStars,
  writeNegativeReviewMaxStars,
} from '../src/index.js'

function createDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-gbp-review-settings-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const now = '2026-09-27T00:00:00.000Z'
  for (const id of ['p1', 'p2']) {
    db.insert(projects).values({
      id, name: id, displayName: id, canonicalDomain: `${id}.example`, country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
  }
  return db
}

test('a project without a row reads as the default', () => {
  const db = createDb()
  expect(readNegativeReviewMaxStars(db, 'p1')).toBeNull()
  expect(readAllNegativeReviewMaxStars(db).size).toBe(0)
})

test('writing stores, overwrites, and null removes the row', () => {
  const db = createDb()
  writeNegativeReviewMaxStars(db, 'p1', 2, '2026-09-27T01:00:00.000Z')
  expect(readNegativeReviewMaxStars(db, 'p1')).toBe(2)

  writeNegativeReviewMaxStars(db, 'p1', 4, '2026-09-27T02:00:00.000Z')
  expect(db.select().from(gbpReviewSettings).all()).toEqual([
    { projectId: 'p1', negativeReviewMaxStars: 4, updatedAt: '2026-09-27T02:00:00.000Z' },
  ])

  writeNegativeReviewMaxStars(db, 'p2', 1, '2026-09-27T02:00:00.000Z')
  expect([...readAllNegativeReviewMaxStars(db)].sort()).toEqual([['p1', 4], ['p2', 1]])

  writeNegativeReviewMaxStars(db, 'p1', null, '2026-09-27T03:00:00.000Z')
  expect(readNegativeReviewMaxStars(db, 'p1')).toBeNull()
  expect(readNegativeReviewMaxStars(db, 'p2')).toBe(1)
})

test('deleting a project removes its setting', () => {
  const db = createDb()
  writeNegativeReviewMaxStars(db, 'p1', 2, '2026-09-27T01:00:00.000Z')
  db.delete(projects).where(eq(projects.id, 'p1')).run()
  expect(db.select().from(gbpReviewSettings).all()).toEqual([])
})
