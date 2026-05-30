import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { ProjectDto } from '@ainyc/canonry-contracts'

const mockPutProject = vi.fn()
const mockGetProject = vi.fn()
const mockRemoveLocation = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    putProject: mockPutProject,
    getProject: mockGetProject,
    removeLocation: mockRemoveLocation,
  }),
}))

/** Capture console.log lines (the machine + human paths both use console.log). */
function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return fn()
    .finally(() => {
      console.log = origLog
    })
    .then(() => logs.join('\n'))
}

const { createProject, showProject, removeLocation } = await import('../src/commands/project.js')

const project: ProjectDto = {
  id: 'proj-1',
  name: 'demo',
  displayName: 'Demo',
  canonicalDomain: 'demo.com',
  ownedDomains: [],
  aliases: ['Demo'],
  country: 'US',
  language: 'en',
  configSource: 'api',
  configRevision: 1,
  tags: [],
  labels: {},
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
}

describe('project mutations — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createProject', () => {
    beforeEach(() => mockPutProject.mockResolvedValue(project))

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const base = {
        domain: 'demo.com',
        country: 'US',
        language: 'en',
        displayName: 'Demo',
      }
      const jsonOut = await captureLog(() => createProject('demo', { ...base, format: 'json' }))
      const jsonlOut = await captureLog(() => createProject('demo', { ...base, format: 'jsonl' }))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toEqual(project)
    })

    it('no format → human line unchanged', async () => {
      const out = await captureLog(() => createProject('demo', {
        domain: 'demo.com', country: 'US', language: 'en', displayName: 'Demo',
      }))
      expect(out).toBe('Project created: demo (proj-1)')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('showProject (single-object read)', () => {
    beforeEach(() => mockGetProject.mockResolvedValue(project))

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => showProject('demo', 'json'))
      const jsonlOut = await captureLog(() => showProject('demo', 'jsonl'))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toEqual(project)
    })

    it('no format → human text block unchanged', async () => {
      const out = await captureLog(() => showProject('demo', undefined))
      expect(out).toContain('Project: Demo')
      expect(out).toContain('Name:             demo')
      expect(() => JSON.parse(out)).toThrow()
    })
  })

  describe('removeLocation', () => {
    beforeEach(() => mockRemoveLocation.mockResolvedValue(undefined))

    it('format=jsonl emits parseable JSON equal to format=json', async () => {
      const jsonOut = await captureLog(() => removeLocation('demo', 'hq', 'json'))
      const jsonlOut = await captureLog(() => removeLocation('demo', 'hq', 'jsonl'))
      expect(jsonlOut).toBe(jsonOut)
      expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
      expect(JSON.parse(jsonlOut)).toEqual({ project: 'demo', label: 'hq', removed: true })
    })

    it('no format → human line unchanged', async () => {
      const out = await captureLog(() => removeLocation('demo', 'hq', undefined))
      expect(out).toBe('Location removed: hq')
      expect(() => JSON.parse(out)).toThrow()
    })
  })
})
