import { bucketDuration } from '@ainyc/canonry-contracts'
import type { TrafficIngestedEvent, TrafficSyncedEvent } from '@ainyc/canonry-api-routes'
import { createOutcomeSampler, trackFeatureCompleted } from './outcome-telemetry.js'
import { trackEvent } from './telemetry.js'

/** `traffic.synced`: one per server-side traffic sync, success or failure. Counts are aggregates; `sourceId` is an opaque UUID. */
export function trackTrafficSynced(event: TrafficSyncedEvent): void {
  trackEvent(
    'traffic.synced',
    {
      status: event.status,
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      pulledEvents: event.pulledEvents,
      selfTrafficExcluded: event.selfTrafficExcluded,
      crawlerHits: event.crawlerHits,
      aiUserFetchHits: event.aiUserFetchHits,
      aiReferralHits: event.aiReferralHits,
      durationMs: event.durationMs,
    },
    event.errorCode ? { errorCode: event.errorCode } : undefined,
  )
}

/**
 * A Worker pushes per batch of requests, all day, so ingest outcomes are
 * sampled per source type and status (a failure is never starved by
 * successes): a burst of 10, then one a minute per key, which keeps the
 * stream well inside the collector's shared per-IP budget.
 */
const sampleIngest = createOutcomeSampler({ burst: 10, refillMs: 60_000, now: () => Date.now() })

/** `feature.completed` `server_traffic`/`ingest` for one authenticated push. */
export function trackTrafficIngested(event: TrafficIngestedEvent): void {
  const sample = sampleIngest(`${event.sourceType}:${event.status}`)
  if (!sample.send) return
  trackFeatureCompleted({
    feature: 'server_traffic',
    operation: 'ingest',
    status: event.status,
    trigger: 'push',
    surface: 'api',
    durationBucket: bucketDuration(event.durationMs),
    ...(event.status === 'succeeded'
      ? {
          counts: {
            events: event.events,
            crawlerHits: event.crawlerHits,
            aiReferralHits: event.aiReferralHits,
            aiUserFetchHits: event.aiUserFetchHits,
          },
        }
      : { reasonCode: event.reasonCode ?? 'UNKNOWN', ...(event.errorName ? { errorName: event.errorName } : {}) }),
    ...(sample.droppedBefore ? { droppedBefore: sample.droppedBefore } : {}),
  })
}
