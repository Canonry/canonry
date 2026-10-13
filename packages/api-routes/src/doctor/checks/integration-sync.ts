import { and, count, desc, eq, gte, gt, inArray, isNull, notInArray, or } from 'drizzle-orm'
import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
  GBP_NO_SELECTED_LOCATIONS_ERROR,
  RunKinds,
  RunStatuses,
  formatRunErrorOneLine,
  parseRunError,
  serializeRunError,
  truncateUtf16,
  type RunKind,
  type RunStatus,
} from '@ainyc/canonry-contracts'
import { gbpLocations, runs } from '@ainyc/canonry-db'
import type { CheckDefinition, CheckOutput, DoctorContext, ProjectInfo } from '../types.js'
import { gaConnected } from './data-freshness.js'

/**
 * Is an integration's sync failing over and over?
 *
 * A queued sync (Google Ads, GTM, GBP, Search Console) answers its endpoint
 * before any provider call, so the scheduled data refresh sees an accepted run
 * and moves on; the failure lands later on the run row. Without this check a
 * sync can fail every day for weeks while every other check stays green: the
 * snapshot-age checks only warn after a week and the auth checks prove a
 * token, not a reachable API host.
 *
 * Grades the newest finished runs (`completed`, `partial`, `failed`; queued,
 * running and cancelled runs prove nothing either way). A `partial` run stored
 * data, so it breaks a failure streak and counts as the last success. When the
 * connection records when it was made, only runs from then on are graded, and
 * the streak and the last success are both counted within that window. A run
 * that failed because it had nothing to sync (GBP with no selected location)
 * is left out entirely.
 *
 * Each check is superseded by its integration's auth checks: a revoked grant
 * fails those and every sync, and the auth check names the fix. An auth check
 * that got no answer from Google (`-unreachable`) supersedes nothing, so a DNS
 * block keeps this check, and the error it names, in the alert.
 */
export const SYNC_FAILURE_WINDOW = 3
const SUMMARY_ERROR_LIMIT = 300

const FINISHED_STATUSES = [RunStatuses.completed, RunStatuses.partial, RunStatuses.failed]
const SUCCESS_STATUSES = [RunStatuses.completed, RunStatuses.partial]
export const GBP_NOTHING_TO_SYNC_ERRORS = [serializeRunError({ message: GBP_NO_SELECTED_LOCATIONS_ERROR })] as const

/**
 * `connected` carries the time the current connection was made, when the
 * store records it. `no-selected-locations` is a GBP connection with nothing
 * to sync: every sync fails by design, as `gbp.data.recent-sync` also skips.
 */
export type Connection =
  | { state: 'connected'; since: string | null }
  | { state: 'not-connected' }
  | { state: 'store-unavailable' }
  | { state: 'no-selected-locations' }

const CONNECTED: Connection = { state: 'connected', since: null }

interface SyncFailureSpec {
  /** Check id and code prefix, matching the integration's other checks (`google-ads.*`, `gsc.*`). */
  prefix: string
  label: string
  kind: RunKind
  connection: (ctx: DoctorContext, project: ProjectInfo) => Connection
  syncCommand: (projectName: string) => string
  /** The integration's auth checks. A failing one names why every sync fails, so it supersedes this check. */
  causeCheckIds: readonly string[]
  /** Stored `runs.error` values of a run that had nothing to sync: neither a failure nor a success. */
  nothingToSyncErrors?: readonly string[]
}

/**
 * Google Ads and GTM: the same resolver their other doctor checks read. A
 * disconnect keeps the redacted connection row and deletes the credential, so
 * the row alone does not mean connected.
 */
export function googleMarketingConnection(provider: 'googleAds' | 'gtm') {
  return (ctx: DoctorContext): Connection => {
    const input = ctx.getGoogleMarketingDoctorInput?.(ctx)
    if (!input) return { state: 'store-unavailable' }
    return input[provider] ? CONNECTED : { state: 'not-connected' }
  }
}

export function gscConnection(ctx: DoctorContext, project: ProjectInfo): Connection {
  if (!ctx.googleConnectionStore) return { state: 'store-unavailable' }
  return ctx.googleConnectionStore.getConnection(project.canonicalDomain, 'gsc') ? CONNECTED : { state: 'not-connected' }
}

/**
 * A GBP connection belongs to the domain, so every project on it counts as
 * connected, but a sync only has work once the project selects a location.
 */
export function gbpConnection(ctx: DoctorContext, project: ProjectInfo): Connection {
  if (!ctx.googleConnectionStore) return { state: 'store-unavailable' }
  if (!ctx.googleConnectionStore.getConnection(project.canonicalDomain, 'gbp')) return { state: 'not-connected' }
  const selected = ctx.db
    .select({ locationName: gbpLocations.locationName })
    .from(gbpLocations)
    .where(and(eq(gbpLocations.projectId, project.id), eq(gbpLocations.selected, true)))
    .limit(1)
    .get()
  return selected ? CONNECTED : { state: 'no-selected-locations' }
}

/**
 * GA4 sync writes its run row before it resolves credentials, so the daily
 * data refresh leaves a failed `ga-sync` row on every project without GA4.
 * Grade only runs since the connection the sync uses (service account first,
 * as the sync resolves it, then OAuth).
 */
export function gaConnection(ctx: DoctorContext, project: ProjectInfo): Connection {
  const state = gaConnected(ctx)
  if (state === 'store-unavailable') return { state }
  if (state === 'not-connected') return { state }
  const serviceAccount = ctx.ga4CredentialStore?.getConnection(project.name)
  const since = serviceAccount
    ? serviceAccount.createdAt
    : ctx.googleConnectionStore?.getConnection(project.canonicalDomain, 'ga4')?.createdAt
  return { state: 'connected', since: since || null }
}

const SPECS: readonly SyncFailureSpec[] = [
  {
    prefix: 'google-ads',
    label: 'Google Ads',
    kind: RunKinds['google-ads-sync'],
    connection: googleMarketingConnection('googleAds'),
    syncCommand: name => `canonry google-ads sync ${name}`,
    causeCheckIds: ['google-ads.auth.connection', 'google-ads.auth.scopes', 'google-ads.account.context', 'google-ads.api.reachable'],
  },
  {
    prefix: 'gtm',
    label: 'Google Tag Manager',
    kind: RunKinds['gtm-sync'],
    connection: googleMarketingConnection('gtm'),
    syncCommand: name => `canonry gtm sync ${name}`,
    causeCheckIds: ['gtm.auth.connection', 'gtm.auth.scopes', 'gtm.container.context', 'gtm.api.reachable'],
  },
  {
    prefix: 'gbp',
    label: 'Google Business Profile',
    kind: RunKinds['gbp-sync'],
    connection: gbpConnection,
    syncCommand: name => `canonry gbp sync ${name}`,
    causeCheckIds: ['gbp.auth.connection', 'gbp.auth.scopes', 'gbp.account.access', 'gbp.api.reachable'],
    // `gbp_locations` does not record when a location was selected, so the
    // runs from before the selection are recognized by the error they stored.
    nothingToSyncErrors: GBP_NOTHING_TO_SYNC_ERRORS,
  },
  {
    prefix: 'ga',
    label: 'GA4',
    kind: RunKinds['ga-sync'],
    connection: gaConnection,
    syncCommand: name => `canonry ga sync ${name}`,
    causeCheckIds: ['ga.auth.connection', 'ga.api.reachable'],
  },
  {
    prefix: 'gsc',
    label: 'Search Console',
    kind: RunKinds['gsc-sync'],
    connection: gscConnection,
    syncCommand: name => `canonry google sync ${name}`,
    causeCheckIds: ['google.auth.connection', 'google.auth.property-access', 'google.auth.scopes', 'gsc.api.reachable'],
  },
]

function skipped(code: string, summary: string): CheckOutput {
  return { status: CheckStatuses.skipped, code, summary, remediation: null }
}

export function latestErrorText(raw: string | null): string {
  const parsed = parseRunError(raw)
  return parsed ? formatRunErrorOneLine(parsed) : 'no error was recorded'
}

export interface SyncRunState {
  latestStatus: RunStatus | null
  latestRunAt: string | null
  latestRunId: string | null
  latestTrigger: string | null
  latestError: string | null
  lastSuccessAt: string | null
  consecutiveFailures: number
  repeatedFailure: boolean
}

export function readSyncRunState(
  db: DoctorContext['db'],
  projectId: string,
  kind: RunKind,
  options: { since?: string | null; nothingToSyncErrors?: readonly string[]; sourceId?: string | null } = {},
): SyncRunState {
  const scope = and(
    eq(runs.projectId, projectId),
    eq(runs.kind, kind),
    ...(options.sourceId ? [eq(runs.sourceId, options.sourceId)] : []),
    ...(options.nothingToSyncErrors?.length ? [or(isNull(runs.error), notInArray(runs.error, [...options.nothingToSyncErrors]))] : []),
  )
  const graded = options.since ? and(scope, gte(runs.createdAt, options.since)) : scope
  const recent = db
    .select({ id: runs.id, status: runs.status, trigger: runs.trigger, error: runs.error, createdAt: runs.createdAt })
    .from(runs)
    .where(and(graded, inArray(runs.status, FINISHED_STATUSES)))
    .orderBy(desc(runs.createdAt))
    .limit(SYNC_FAILURE_WINDOW)
    .all()
  const lastSuccess = db
    .select({ createdAt: runs.createdAt, finishedAt: runs.finishedAt })
    .from(runs)
    .where(and(graded, inArray(runs.status, SUCCESS_STATUSES)))
    .orderBy(desc(runs.createdAt))
    .limit(1)
    .get()
  const failureCount = db
    .select({ count: count() })
    .from(runs)
    .where(and(lastSuccess ? and(graded, gt(runs.createdAt, lastSuccess.createdAt)) : graded, eq(runs.status, RunStatuses.failed)))
    .get()
  const failuresSinceSuccess = Number(failureCount?.count ?? 0)
  const latest = recent[0]
  return {
    latestStatus: latest?.status as RunStatus | undefined ?? null,
    latestRunAt: latest?.createdAt ?? null,
    latestRunId: latest?.id ?? null,
    latestTrigger: latest?.trigger ?? null,
    latestError: latest?.status === RunStatuses.failed ? latestErrorText(latest.error) : null,
    lastSuccessAt: lastSuccess ? lastSuccess.finishedAt ?? lastSuccess.createdAt : null,
    consecutiveFailures: failuresSinceSuccess,
    repeatedFailure: recent.length >= SYNC_FAILURE_WINDOW && recent.every(run => run.status === RunStatuses.failed),
  }
}

function gradeSyncFailures(ctx: DoctorContext, spec: SyncFailureSpec): CheckOutput {
  const code = (suffix: string) => `${spec.prefix}.sync.${suffix}`
  const project = ctx.project
  if (!project) return skipped(code('no-project'), 'Project context required.')
  const connection = spec.connection(ctx, project)
  if (connection.state === 'store-unavailable') {
    return skipped(code('store-unavailable'), `No ${spec.label} connection store configured for this deployment.`)
  }
  // A disconnected integration's old failures are not a live problem.
  if (connection.state === 'not-connected') {
    return skipped(code('not-connected'), `${spec.label} is not connected for this project.`)
  }
  if (connection.state === 'no-selected-locations') {
    return skipped(code('no-selected-locations'), `No ${spec.label} locations are selected for this project.`)
  }

  const nothingToSync = spec.nothingToSyncErrors ?? []
  const state = readSyncRunState(ctx.db, project.id, spec.kind, { since: connection.since, nothingToSyncErrors: nothingToSync })
  if (state.latestStatus === null) {
    return skipped(code('no-runs'), `${spec.label} is connected but no sync has finished yet.`)
  }

  const latestFailed = state.latestStatus === RunStatuses.failed
  const details = {
    runKind: spec.kind,
    window: SYNC_FAILURE_WINDOW,
    consecutiveFailures: state.consecutiveFailures,
    latestStatus: state.latestStatus,
    latestRunAt: state.latestRunAt,
    latestError: state.latestError,
    lastSuccessAt: state.lastSuccessAt,
    // Where the graded runs start (the current connection); null grades every run.
    gradedSince: connection.since,
  }

  if (state.repeatedFailure) {
    const errorText = state.latestError ?? 'no error was recorded'
    const shownError = errorText.length > SUMMARY_ERROR_LIMIT ? `${truncateUtf16(errorText, SUMMARY_ERROR_LIMIT)}...` : errorText
    const lastSuccessText = state.lastSuccessAt ?? (connection.since ? `none since connecting at ${connection.since}` : 'never')
    return {
      status: CheckStatuses.fail,
      code: code('repeated-failures'),
      summary: `The last ${state.consecutiveFailures} ${spec.label} syncs failed (last success: ${lastSuccessText}). Latest error: ${shownError}`,
      remediation: `Fix the cause the latest error names (DNS or network filtering of the API host, credentials, or account access), then run \`${spec.syncCommand(project.name)}\`.`,
      details,
    }
  }
  return {
    status: CheckStatuses.ok,
    code: code('ok'),
    summary: latestFailed
      ? `The latest ${spec.label} sync failed, but not ${SYNC_FAILURE_WINDOW} in a row.`
      : `The latest ${spec.label} sync ${state.latestStatus === RunStatuses.partial ? 'partly completed' : 'completed'}.`,
    remediation: null,
    details,
  }
}

export const INTEGRATION_SYNC_CHECKS: readonly CheckDefinition[] = SPECS.map(spec => ({
  id: `${spec.prefix}.sync.recent-failures`,
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: `${spec.label} sync failures`,
  supersededBy: spec.causeCheckIds,
  run: ctx => gradeSyncFailures(ctx, spec),
}))
