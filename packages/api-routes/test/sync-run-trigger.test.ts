import { describe, expect, it, vi } from 'vitest'
import { RunKinds, RunTriggers, type RunKind } from '@ainyc/canonry-contracts'
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

  it('keeps traffic source claims independent', () => {
    expect(syncRunClaimKey('project', RunKinds['traffic-sync'], 'source-a'))
      .not.toBe(syncRunClaimKey('project', RunKinds['traffic-sync'], 'source-b'))
    expect(syncRunClaimKey('project', RunKinds['traffic-sync'], 'source-a'))
      .toBe('project\u0000traffic-sync\u0000source-a')
  })
})
