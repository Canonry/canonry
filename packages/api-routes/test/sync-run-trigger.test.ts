import { describe, expect, it, vi } from 'vitest'
import { RunKinds, RunTriggers, type RunKind } from '@canonry/canonry-contracts'
import { syncRunClaimKey, syncRunTrigger } from '../src/helpers.js'

describe('scheduled sync trigger provenance', () => {
  it('uses scheduled once the host claim is consumed, and manual otherwise', () => {
    const claims = new Set([syncRunClaimKey('project', RunKinds['gsc-sync'])])
    const claim = vi.fn((projectName: string, kind: RunKind, sourceId?: string) => {
      const key = syncRunClaimKey(projectName, kind, sourceId)
      return claims.delete(key)
    })

    expect(syncRunTrigger(claim, 'project', RunKinds['gsc-sync'])).toBe(RunTriggers.scheduled)
    expect(syncRunTrigger(claim, 'project', RunKinds['gsc-sync'])).toBe(RunTriggers.manual)
    expect(claim).toHaveBeenNthCalledWith(1, 'project', RunKinds['gsc-sync'], undefined)
    expect(claim).toHaveBeenNthCalledWith(2, 'project', RunKinds['gsc-sync'], undefined)
  })

  it('keeps a claim for one traffic source from labeling another source', () => {
    const claims = new Set([syncRunClaimKey('project', RunKinds['traffic-sync'], 'source-a')])
    const claim = (projectName: string, kind: RunKinds[keyof typeof RunKinds], sourceId?: string) =>
      claims.delete(syncRunClaimKey(projectName, kind, sourceId))

    expect(syncRunTrigger(claim, 'project', RunKinds['traffic-sync'], 'source-b')).toBe(RunTriggers.manual)
    expect(syncRunTrigger(claim, 'project', RunKinds['traffic-sync'], 'source-a')).toBe(RunTriggers.scheduled)
  })
})
