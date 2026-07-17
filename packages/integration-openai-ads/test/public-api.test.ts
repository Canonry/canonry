import { describe, expect, it } from 'vitest'
import * as publicApi from '../src/index.js'

describe('public package API', () => {
  it('exposes pause but not activation primitives', () => {
    expect(publicApi).toMatchObject({
      pauseCampaign: expect.any(Function),
      pauseAdGroup: expect.any(Function),
      pauseAd: expect.any(Function),
    })
    expect(Object.keys(publicApi)).not.toEqual(expect.arrayContaining([
      'activateCampaign',
      'activateAdGroup',
      'activateAd',
    ]))
  })
})
