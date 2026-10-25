import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockListSources = vi.fn()
const mockDeclareGap = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ trafficListSources: mockListSources, trafficDeclareGap: mockDeclareGap }),
}))

const { trafficDeclareGap } = await import('../src/commands/traffic.js')

const SKIPPED = '2026-08-20T20:39:49.403Z'
const source = (skippedThroughAt: string | null) => ({ id: 'src_wp', displayName: 'WordPress · site.example', skippedThroughAt })

describe('canonry traffic declare-gap', () => {
  beforeEach(() => {
    mockListSources.mockReset()
    mockDeclareGap.mockReset()
  })

  it('sends back the exact marker it read, so a newer skip is refused rather than cleared', async () => {
    mockListSources.mockResolvedValue({ sources: [source(SKIPPED)] })
    mockDeclareGap.mockResolvedValue({ ...source(null) })
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })

    await trafficDeclareGap('demo', { source: 'src_wp' })
    spy.mockRestore()

    expect(mockDeclareGap).toHaveBeenCalledWith('demo', 'src_wp', SKIPPED)
    expect(logs[0]).toBe(`Recorded the gap through ${SKIPPED} on "WordPress · site.example" as lost for good.`)
  })

  it('says so when the source has no gap, without calling the server', async () => {
    mockListSources.mockResolvedValue({ sources: [source(null)] })
    await expect(trafficDeclareGap('demo', { source: 'src_wp' })).rejects.toThrow(/no unrecovered gap/)
    await expect(trafficDeclareGap('demo', { source: 'src_missing' })).rejects.toThrow(/not found/)
    expect(mockDeclareGap).not.toHaveBeenCalled()
  })
})
