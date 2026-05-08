import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, projects, queries as queriesTable } from '@ainyc/canonry-db'
import { saveConfig } from '../src/config.js'
import { buildSetupState } from '../src/setup-state.js'

const tmpDir = path.join(os.tmpdir(), `canonry-setup-state-test-${crypto.randomUUID()}`)

describe('buildSetupState', () => {
  let originalConfigDir: string | undefined

  beforeEach(() => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    const testDir = path.join(tmpDir, crypto.randomUUID())
    fs.mkdirSync(testDir, { recursive: true })
    process.env.CANONRY_CONFIG_DIR = testDir
  })

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = originalConfigDir
    }
  })

  it('returns undefined when no config exists (pre-init)', () => {
    expect(buildSetupState()).toBe(undefined)
  })

  it('returns is_first_run=true and zeroed counts when only a config exists', () => {
    const dbPath = path.join(tmpDir, `${crypto.randomUUID()}.db`)
    saveConfig({
      apiUrl: 'http://localhost:4100',
      database: dbPath,
      apiKey: 'cnry_test',
    })
    const state = buildSetupState()
    expect(state).toEqual({
      provider_count: 0,
      has_keywords: false,
      project_count: 0,
      is_first_run: true,
    })
  })

  it('counts only providers with apiKey or baseUrl set', () => {
    const dbPath = path.join(tmpDir, `${crypto.randomUUID()}.db`)
    saveConfig({
      apiUrl: 'http://localhost:4100',
      database: dbPath,
      apiKey: 'cnry_test',
      providers: {
        gemini: { apiKey: 'sk-gemini' },
        openai: { apiKey: 'sk-openai', model: 'gpt-4' },
        // baseUrl-only is a valid local-llm config — must count.
        local: { baseUrl: 'http://127.0.0.1:11434' },
        // model-only without apiKey/baseUrl is configured but unusable.
        anthropic: { model: 'claude-opus' },
      },
    })
    const state = buildSetupState()
    expect(state?.provider_count).toBe(3)
  })

  it('flips is_first_run to false once anonymousId is set', () => {
    const dbPath = path.join(tmpDir, `${crypto.randomUUID()}.db`)
    saveConfig({
      apiUrl: 'http://localhost:4100',
      database: dbPath,
      apiKey: 'cnry_test',
      anonymousId: crypto.randomUUID(),
    })
    expect(buildSetupState()?.is_first_run).toBe(false)
  })

  it('reports project_count and has_keywords from the live DB', () => {
    const dbPath = path.join(tmpDir, `${crypto.randomUUID()}.db`)
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })

    // Create + migrate the DB before saving the config so buildSetupState
    // sees a populated schema.
    const db = createClient(dbPath)
    migrate(db)

    const now = new Date().toISOString()
    const projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId,
      name: 'p1',
      displayName: 'P1',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      providers: '[]',
      createdAt: now,
      updatedAt: now,
    }).run()
    db.insert(projects).values({
      id: crypto.randomUUID(),
      name: 'p2',
      displayName: 'P2',
      canonicalDomain: 'other.com',
      country: 'US',
      language: 'en',
      providers: '[]',
      createdAt: now,
      updatedAt: now,
    }).run()
    db.insert(queriesTable).values({
      id: crypto.randomUUID(),
      projectId,
      query: 'best aeo tool',
      createdAt: now,
    }).run()

    saveConfig({
      apiUrl: 'http://localhost:4100',
      database: dbPath,
      apiKey: 'cnry_test',
    })

    const state = buildSetupState()
    expect(state?.project_count).toBe(2)
    expect(state?.has_keywords).toBe(true)
  })

  it('degrades gracefully when DB path is set but file does not exist', () => {
    saveConfig({
      apiUrl: 'http://localhost:4100',
      database: path.join(tmpDir, 'nonexistent', `${crypto.randomUUID()}.db`),
      apiKey: 'cnry_test',
    })
    const state = buildSetupState()
    expect(state?.project_count).toBe(0)
    expect(state?.has_keywords).toBe(false)
  })
})
