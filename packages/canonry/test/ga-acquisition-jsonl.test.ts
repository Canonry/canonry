import { beforeEach, describe, expect, it, vi } from 'vitest'
const get = vi.fn()
vi.mock('../src/client.js', () => ({ createApiClient: () => ({ gaAcquisition: get }) }))
const { gaAcquisition } = await import('../src/commands/ga.js')
const response = {"source":"ga4-acquisition","status":"ready","error":null,"syncedAt":"2026-10-01T12:00:00.000Z","scope":{"project":"example","attribution":"project-only","unavailableDimensions":["property","target","market"]},"window":{"startDate":"2026-09-01","endDate":"2026-09-30","window":"all"},"coverage":{"earliestDate":"2026-09-10","latestDate":"2026-09-10"},"filters":{"channel":"Organic Search","source":null,"medium":null,"hostName":null,"landingPage":null,"pathPrefix":null},"groupBy":["source","medium"],"channelGroups":["Organic Search"],"totalSessions":18,"totalRows":1,"limit":20,"offset":0,"rows":[{"source":"google","medium":"organic","sessions":18}]}
describe('GA acquisition output', () => {
  beforeEach(() => { get.mockReset().mockResolvedValue(response) })
  it('prints the unchanged API envelope as JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try { await gaAcquisition('example', { format: 'json' }); expect(JSON.parse(log.mock.calls[0]![0])).toEqual(response) } finally { log.mockRestore() }
  })
  it('streams one grouped row per JSONL line with project and window', async () => {
    let output = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true })
    try { await gaAcquisition('example', { format: 'jsonl' }) } finally { write.mockRestore() }
    expect(output.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ project: 'example', windowStart: '2026-09-01', windowEnd: '2026-09-30', source: 'google', medium: 'organic', sessions: 18 }])
  })
  it('reports filtered totals in text without recalculating the page', async () => {
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.join(' ')) })
    try { await gaAcquisition('example', {}) } finally { log.mockRestore() }
    expect(lines.join('\n')).toContain('1 of 1 rows, 18 sessions in window')
    expect(lines.join('\n')).toContain('google  organic  18')
  })
})
