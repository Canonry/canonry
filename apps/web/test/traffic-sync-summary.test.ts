import { expect, test } from 'vitest'
import type { TrafficSyncResponse } from '@canonry/canonry-contracts'

import { BROWSER_AGENT_NON_PAGE_LABEL, trafficSyncSummary } from '../src/pages/TrafficSourceDetailPage.js'

const synced: TrafficSyncResponse = {
  sourceId: 'source', runId: 'run', syncedAt: '2026-11-11T12:00:00.000Z', pulledEvents: 31, selfTrafficExcluded: 0,
  crawlerHits: 5, aiUserFetchHits: 4, aiUserFetchLikelyFakeHits: 1, aiUserFetchBrowserNonPageHits: 19, aiReferralHits: 2, unknownHits: 0,
  crawlerBucketRows: 2, aiUserFetchBucketRows: 2, aiReferralBucketRows: 1, sampleRows: 31,
  windowStart: '2026-11-11T11:00:00.000Z', windowEnd: '2026-11-11T12:00:00.000Z',
}

test('the Sync now summary names a browser agent\'s requests other than page loads, as the CLI does', () => {
  expect(trafficSyncSummary(synced)).toContain(`19 ${BROWSER_AGENT_NON_PAGE_LABEL}`)
})

test('the Sync now summary leaves the count out when a sync had none, or the server predates it', () => {
  expect(trafficSyncSummary({ ...synced, aiUserFetchBrowserNonPageHits: 0 })).not.toContain(BROWSER_AGENT_NON_PAGE_LABEL)
  expect(trafficSyncSummary({ ...synced, aiUserFetchBrowserNonPageHits: undefined })).not.toContain(BROWSER_AGENT_NON_PAGE_LABEL)
})
