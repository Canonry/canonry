import { eq } from 'drizzle-orm'
import { projects, type DatabaseClient } from '@canonry/canonry-db'
import { BING_THROTTLE_COOLDOWN_MS, bingThrottleCooldownRemainingMs } from '@canonry/canonry-integration-bing'
import type { CanonryConfig } from './config.js'
import { credentialGateKey, type SleepFn } from './inspect-rate-gate.js'
import { createLogger } from './logger.js'

/**
 * One Bing job at a time per API key, data syncs before page inspections.
 *
 * Bing limits the ACCOUNT, and one key serves every project on the instance.
 * The shared rate gate spaces request starts, but it cannot stop the jobs on a
 * key from spending the account's allowance together: the daily refresh
 * started three projects' syncs and page inspections in the same minute, Bing
 * throttled the key about a minute later, and every sync lost its last
 * sections to the cooldown that followed, every day for three weeks.
 *
 * So jobs on one key queue here and run one after another. A waiting data sync
 * starts before a waiting inspection, because a sync carries the search data
 * and an inspection only moves the page-check rotation along. A job that finds
 * the key in a throttle cooldown waits it out before starting, rather than
 * spending its run on calls the client refuses unattempted.
 *
 * The run stays `queued` while it waits: the executors mark it `running` only
 * once they start.
 */

const log = createLogger('BingJobLane')

/** `sync` is `bing-sync`; `inspect` is `bing-inspect-sitemap`. */
export type BingJobKind = 'sync' | 'inspect'

/**
 * The longest a job waits for an open throttle cooldown before it starts: one
 * cooldown plus a minute. A `Retry-After` can stretch a cooldown far longer;
 * past this bound the job starts anyway and its calls fail fast, as before.
 */
export const BING_LANE_MAX_COOLDOWN_WAIT_MS = BING_THROTTLE_COOLDOWN_MS + 60_000

interface Lane {
  waiting: Array<{ kind: BingJobKind; start: () => void }>
}

/** Busy lanes by key digest. A key with no running job has no entry. */
const lanes = new Map<string, Lane>()

function acquire(key: string, kind: BingJobKind): Promise<void> {
  const lane = lanes.get(key)
  if (!lane) {
    lanes.set(key, { waiting: [] })
    return Promise.resolve()
  }
  log.info('lane.wait', { kind, ahead: lane.waiting.length + 1 })
  return new Promise<void>((start) => lane.waiting.push({ kind, start }))
}

/** Hands the lane to the first waiting sync, else the first waiting inspection. */
function release(key: string): void {
  const lane = lanes.get(key)
  if (!lane) return
  const syncIndex = lane.waiting.findIndex((waiter) => waiter.kind === 'sync')
  const next = syncIndex >= 0 ? lane.waiting.splice(syncIndex, 1)[0] : lane.waiting.shift()
  if (next) next.start()
  else lanes.delete(key)
}

const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `work` once the key's lane is free and any throttle cooldown on it has passed. */
export async function runInBingLane<T>(
  apiKey: string,
  kind: BingJobKind,
  work: () => Promise<T>,
  deps: { sleep?: SleepFn } = {},
): Promise<T> {
  const key = credentialGateKey('bing', apiKey)
  await acquire(key, kind)
  try {
    const cooling = bingThrottleCooldownRemainingMs(apiKey)
    if (cooling > 0) {
      const waitMs = Math.min(cooling, BING_LANE_MAX_COOLDOWN_WAIT_MS)
      log.info('lane.cooldown-wait', { kind, waitMs })
      await (deps.sleep ?? realSleep)(waitMs)
    }
    return await work()
  } finally {
    release(key)
  }
}

/** The Bing API key a project's jobs use, or null without a Bing connection. */
export function bingApiKeyForProject(db: DatabaseClient, config: CanonryConfig, projectId: string): string | null {
  const project = db.select({ canonicalDomain: projects.canonicalDomain }).from(projects).where(eq(projects.id, projectId)).get()
  if (!project) return null
  return config.bing?.connections?.find((conn) => conn.domain === project.canonicalDomain)?.apiKey ?? null
}

/**
 * Runs a project's Bing job in its key's lane. A project with no Bing
 * connection has no lane to wait in: the job runs at once and fails with its
 * own "not connected" message. Async so a failed key lookup rejects like the
 * job itself would, instead of throwing into the route that queued the run.
 */
export async function runBingJob<T>(
  db: DatabaseClient,
  config: CanonryConfig,
  projectId: string,
  kind: BingJobKind,
  work: () => Promise<T>,
  deps: { sleep?: SleepFn } = {},
): Promise<T> {
  const apiKey = bingApiKeyForProject(db, config, projectId)
  return apiKey ? await runInBingLane(apiKey, kind, work, deps) : await work()
}

/** Test seam: forget every lane. */
export function __resetBingJobLanesForTest(): void {
  lanes.clear()
}
