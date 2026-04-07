import { describe, it, expect } from 'vitest'
import { detectGains } from '../src/gains.js'
import type { RunData } from '../src/types.js'

describe('gains', () => {
  const previousRun: RunData = {
    runId: 'run_001',
    projectId: 'proj_1',
    completedAt: '2026-04-01T00:00:00Z',
    snapshots: [
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: true },
      { keyword: 'roof coating', provider: 'chatgpt', cited: false },
      { keyword: 'roof coating', provider: 'gemini', cited: false },
    ],
  }

  const currentRun: RunData = {
    runId: 'run_002',
    projectId: 'proj_1',
    completedAt: '2026-04-02T00:00:00Z',
    snapshots: [
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: true },
      { keyword: 'roof coating', provider: 'chatgpt', cited: true, citationUrl: 'https://example.com/coating', position: 3, snippet: 'Great coating...' }, // GAIN
      { keyword: 'roof coating', provider: 'gemini', cited: false },
    ],
  }

  it('returns new citations', () => {
    const gains = detectGains(currentRun, previousRun)
    expect(gains).toHaveLength(1)
    expect(gains[0].keyword).toBe('roof coating')
    expect(gains[0].provider).toBe('chatgpt')
  })

  it('returns empty array when no gains', () => {
    const gains = detectGains(previousRun, previousRun)
    expect(gains).toHaveLength(0)
  })

  it('includes position and snippet from current run', () => {
    const gains = detectGains(currentRun, previousRun)
    expect(gains[0].position).toBe(3)
    expect(gains[0].snippet).toBe('Great coating...')
    expect(gains[0].citationUrl).toBe('https://example.com/coating')
  })
})
