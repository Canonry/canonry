import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-alias-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...opts })

  return { app, db, tmpDir }
}

async function putProject(
  app: ReturnType<typeof Fastify>,
  name: string,
  patch: Record<string, unknown>,
) {
  const payload = {
    displayName: 'Acme Inc',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    ...patch,
  }
  return app.inject({ method: 'PUT', url: `/api/v1/projects/${name}`, payload })
}

describe('PUT /projects/:name — onAliasesChanged trigger', () => {
  it('does not fire on project creation (no historical snapshots to backfill)', async () => {
    const calls: Array<{ projectId: string; projectName: string }> = []
    const { app, tmpDir } = buildApp({
      onAliasesChanged: (projectId, projectName) => calls.push({ projectId, projectName }),
    })
    try {
      await app.ready()
      const res = await putProject(app, 'created', { aliases: ['Acme', 'AcmeCo'] })
      expect(res.statusCode).toBe(201)
      expect(calls).toEqual([])
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('fires when an existing project gains an alias', async () => {
    const calls: Array<{ projectId: string; projectName: string }> = []
    const { app, tmpDir } = buildApp({
      onAliasesChanged: (projectId, projectName) => calls.push({ projectId, projectName }),
    })
    try {
      await app.ready()
      await putProject(app, 'evolves', { aliases: [] })
      expect(calls).toEqual([])
      await putProject(app, 'evolves', { aliases: ['Acme'] })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.projectName).toBe('evolves')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not fire when re-saving the same aliases (only other fields changed)', async () => {
    const calls: Array<{ projectId: string; projectName: string }> = []
    const { app, tmpDir } = buildApp({
      onAliasesChanged: (projectId, projectName) => calls.push({ projectId, projectName }),
    })
    try {
      await app.ready()
      await putProject(app, 'unchanged', { aliases: ['Acme'] }) // create
      await putProject(app, 'unchanged', { aliases: ['Acme'] }) // touch
      expect(calls).toEqual([])
      // Re-save with same aliases + a different country — still no fire.
      await putProject(app, 'unchanged', { aliases: ['Acme'], country: 'CA' })
      expect(calls).toEqual([])
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not fire when only casing differs — server normalization dedupes', async () => {
    // The normalizer preserves the first-seen casing, so re-saving with the
    // same logical set in different casing produces the same persisted list.
    // No backfill should fire.
    const calls: Array<{ projectId: string; projectName: string }> = []
    const { app, tmpDir } = buildApp({
      onAliasesChanged: (projectId, projectName) => calls.push({ projectId, projectName }),
    })
    try {
      await app.ready()
      await putProject(app, 'casing', { aliases: ['Acme'] }) // create
      await putProject(app, 'casing', { aliases: ['ACME'] }) // same normalized set
      // First saved alias was "Acme", the lowercase re-save's "ACME" is a dup
      // of the existing key so it collapses out — the persisted list stays
      // ["Acme"], which equals the prior list. No fire.
      const final = await putProject(app, 'casing', { aliases: ['Acme'] })
      expect(final.statusCode).toBe(200)
      expect(calls).toEqual([])
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('fires when displayName change collapses an alias out of the set', async () => {
    // Alias === displayName is silently filtered. So renaming the project
    // such that an existing alias now matches its displayName drops that
    // alias from the persisted set — a real change worth backfilling.
    const calls: Array<{ projectId: string; projectName: string }> = []
    const { app, tmpDir } = buildApp({
      onAliasesChanged: (projectId, projectName) => calls.push({ projectId, projectName }),
    })
    try {
      await app.ready()
      await putProject(app, 'rename', { displayName: 'Acme Inc', aliases: ['Foo'] })
      await putProject(app, 'rename', { displayName: 'Foo', aliases: ['Foo'] })
      expect(calls).toHaveLength(1)
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
