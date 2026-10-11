import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeCli } from './cli-test-utils.js'

const client = vi.hoisted(() => ({ listCompetitors: vi.fn(), appendCompetitors: vi.fn(), getProject: vi.fn(), setCompetitorAliases: vi.fn() }))
vi.mock('../src/client.js', () => ({ createApiClient: () => client }))
vi.mock('../src/skills-autosync.js', () => ({ autoSyncSkills: async () => null, formatAutoSyncNotice: () => null }))
let directory: string
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('DO_NOT_TRACK', '1')
  vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'competitor-import-'))
  client.listCompetitors.mockResolvedValue([])
  client.appendCompetitors.mockResolvedValue([{ id: 'rival', domain: 'rival.example', aliases: ['Rival Name'] }])
  client.getProject.mockResolvedValue({ answerFieldsRecompute: null })
  client.setCompetitorAliases.mockResolvedValue({ id: 'rival', domain: 'rival.example', aliases: ['New Name'] })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }) })

const args = ['competitor', 'add', 'example', 'rival.example', '--alias', 'Rival Name']

describe('competitor import and completion', () => {
  it('does not report a legacy subdomain row as newly added', async () => {
    const file = path.join(directory, 'legacy.json'); fs.writeFileSync(file, JSON.stringify(['spoketuneworks.example']))
    const legacy = { id: 'legacy', domain: 'offers.spoketuneworks.example', aliases: [] }
    const canonical = { ...legacy, domain: 'spoketuneworks.example' }
    client.listCompetitors.mockResolvedValue([legacy])
    client.appendCompetitors.mockResolvedValue([canonical])

    const result = await invokeCli(['competitor', 'import', 'example', file, '--format', 'json'])

    expect(result.exitCode, result.stderr).toBeUndefined()
    expect(JSON.parse(result.stdout)).toMatchObject({ domains: ['spoketuneworks.example'], addedDomains: [], addedCount: 0 })
  })

  it('imports eight entries with aliases in one append and reports an idempotent second import', async () => {
    const entries = Array.from({ length: 8 }, (_, index) => index < 3 ? { domain: `rival${index}.example`, aliases: [`Rival Name ${index}`] } : `rival${index}.example`)
    const file = path.join(directory, 'competitors.json'); fs.writeFileSync(file, JSON.stringify(entries))
    const rows = entries.map((entry, index) => ({ id: String(index), domain: typeof entry === 'string' ? entry : entry.domain, aliases: typeof entry === 'string' ? [] : entry.aliases }))
    client.appendCompetitors.mockResolvedValue(rows)
    const first = await invokeCli(['competitor', 'import', 'example', file, '--format', 'json'])
    expect(first.exitCode, first.stderr).toBeUndefined()
    expect(client.appendCompetitors).toHaveBeenCalledExactlyOnceWith('example', entries)
    expect(JSON.parse(first.stdout)).toMatchObject({ project: 'example', addedCount: 8, domains: rows.map(row => row.domain) })
    client.listCompetitors.mockResolvedValue(rows)
    const again = await invokeCli(['competitor', 'import', 'example', file, '--format', 'json'])
    expect(again.exitCode, again.stderr).toBeUndefined()
    expect(JSON.parse(again.stdout).addedCount).toBe(0)
  })

  it('reads commented line files with comma-separated aliases', async () => {
    const file = path.join(directory, 'competitors.txt'); fs.writeFileSync(file, '# Curated entries\n rival.example, Rival Name, Second Name\n\n other.example\n')
    const lines: string[] = []
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true })
    try {
      const result = await invokeCli(['competitor', 'import', 'example', file, '--format', 'jsonl'])
      expect(result.exitCode, result.stderr).toBeUndefined()
      expect(client.appendCompetitors).toHaveBeenCalledExactlyOnceWith('example', [{ domain: 'rival.example', aliases: ['Rival Name', 'Second Name'] }, 'other.example'])
      expect(JSON.parse(lines.join('')).addedCount).toBe(1)
    } finally { output.mockRestore() }
  })

  it('rejects malformed entries before any write and identifies their index', async () => {
    const file = path.join(directory, 'invalid.json'); fs.writeFileSync(file, JSON.stringify(['rival.example', { domain: 4, aliases: [] }]))
    const result = await invokeCli(['competitor', 'import', 'example', file, '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: { issues: expect.arrayContaining([expect.objectContaining({ path: expect.arrayContaining([1]) })]) } } })
    expect(client.appendCompetitors).not.toHaveBeenCalled()
  })

  it('reports a missing input file without writing', async () => {
    const result = await invokeCli(['competitor', 'import', 'example', path.join(directory, 'missing.json'), '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).error.code).toBe('COMPETITOR_IMPORT_FILE_NOT_FOUND')
    expect(client.appendCompetitors).not.toHaveBeenCalled()
  })

  it('waits through competitors and full recomputation before printing success', async () => {
    vi.useFakeTimers()
    client.getProject.mockResolvedValueOnce({ answerFieldsRecompute: 'competitors' }).mockResolvedValueOnce({ answerFieldsRecompute: 'full' }).mockResolvedValue({ answerFieldsRecompute: null })
    const pending = invokeCli([...args, '--wait', '--format', 'json'])
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending
    expect(result.exitCode, result.stderr).toBeUndefined()
    expect(client.appendCompetitors).toHaveBeenCalledOnce()
    expect(client.getProject).toHaveBeenCalledTimes(3)
    expect(JSON.parse(result.stdout).addedCount).toBe(1)
  })

  it('times out after the committed write with an in-progress error and no success output', async () => {
    vi.useFakeTimers()
    client.getProject.mockResolvedValue({ answerFieldsRecompute: 'competitors' })
    const pending = invokeCli([...args, '--wait', '--wait-timeout', '1', '--format', 'json'])
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'OPERATION_IN_PROGRESS', details: { project: 'example', writeCommitted: true } } })
    expect(client.appendCompetitors).toHaveBeenCalledOnce()
  })

  it('retains ordinary add output and skips completion reads without --wait', async () => {
    const result = await invokeCli([...args, '--format', 'json'])
    expect(result.exitCode, result.stderr).toBeUndefined()
    expect(JSON.parse(result.stdout)).toMatchObject({ project: 'example', domains: ['rival.example'], addedDomains: ['rival.example'], addedCount: 1 })
    expect(client.getProject).not.toHaveBeenCalled()
  })

  it.each(['0', '-1', 'nope', '1.5'])('rejects wait timeout %s before a write', async timeout => {
    const result = await invokeCli([...args, '--wait', '--wait-timeout', timeout, '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).error.code).toBe('CLI_USAGE_ERROR')
    expect(client.appendCompetitors).not.toHaveBeenCalled()
  })

  it.each([[['--wait-timeout', '5']], [['--wait', '--dry-run']]])('rejects inconsistent completion options %j before writing', async options => {
    const result = await invokeCli([...args, ...options, '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).error.code).toBe('CLI_USAGE_ERROR')
    expect(client.appendCompetitors).not.toHaveBeenCalled()
  })

  it('does not claim completion when an older server omits the status', async () => {
    client.getProject.mockResolvedValue({})
    const result = await invokeCli([...args, '--wait', '--format', 'json'])
    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'WAIT_STATUS_UNAVAILABLE', details: { writeCommitted: true } } })
    expect(result.stdout).toBe('')
    expect(client.appendCompetitors).toHaveBeenCalledOnce()
  })

  it('waits after a curated alias edit too', async () => {
    const result = await invokeCli(['competitor', 'aliases', 'example', 'rival.example', '--set', 'New Name', '--wait', '--format', 'json'])
    expect(result.exitCode, result.stderr).toBeUndefined()
    expect(client.setCompetitorAliases).toHaveBeenCalledExactlyOnceWith('example', 'rival.example', ['New Name'])
    expect(client.getProject).toHaveBeenCalledOnce()
  })
})
