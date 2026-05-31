import crypto from 'node:crypto'
import { eq, ne, sql, type SQL } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import type { FastifyRequest } from 'fastify'
import { projects, runs, auditLog, usageCounters, parseJsonColumn } from '@ainyc/canonry-db'
import {
  extractAnswerMentions,
  effectiveBrandNames,
  effectiveDomains,
  forbidden,
  mentionStateFromAnswerMentioned,
  notFound,
  quotaExceeded,
  RunTriggers,
  visibilityStateFromAnswerMentioned,
  type MentionState,
  type VisibilityState,
} from '@ainyc/canonry-contracts'

/**
 * Drizzle predicate that excludes probe runs (`trigger='probe'`).
 *
 * Probe runs are operator/agent test runs that write snapshots so the
 * operator can inspect provider behavior, but they must NEVER influence
 * dashboard / analytics / report / timeline aggregates. Every read-aggregate
 * query that touches `runs` MUST AND-in this predicate. See
 * `packages/api-routes/test/probe-exclusion.test.ts` for the surface map.
 *
 * INCLUDE probes in: per-run detail endpoints (caller passes the runId),
 * delete-preview cascade counts (must show true blast radius), the operator
 * run-list view (`GET /projects/:name/runs`).
 */
export function notProbeRun(): SQL {
  return ne(runs.trigger, RunTriggers.probe)
}

export function resolveProject(db: DatabaseClient, name: string) {
  const project = db.select().from(projects).where(eq(projects.name, name)).get()
  if (!project) {
    throw notFound('Project', name)
  }
  return project
}

/**
 * Track 3 (Canonry Hosted) — gate for cloud-bridge routes.
 *
 * The cloud bridge endpoints (`/cloud/bootstrap`, `/cloud/google/import-tokens`,
 * `/cloud/bing/import-key`) are designed to be invoked only from a sibling
 * control-plane container that the operator has deliberately provisioned.
 * OSS deployments should not expose them at all — calling code paths returns
 * a 404 indistinguishable from "no such route" when the env flag is unset.
 *
 * Two-layer gate:
 *   1. `CANONRY_ENABLE_CLOUD_BOOTSTRAP=1` (env, set by the host-operator's
 *      Compose template) — Track 1 owns this flag definitively. This helper
 *      currently re-reads `process.env` rather than threading config plumbing
 *      because Track 1 hasn't shipped yet and we don't want to race them on
 *      `index.ts` options. Consolidate when Track 1 lands.
 *   2. `X-Admin-Scope: 1` header — gates per-request. The control plane sets
 *      this header on every cloud-bridge call. Anyone else who somehow gets
 *      hold of a valid `cnry_…` key (which already has full instance access
 *      per the deployment-posture rules) will still be rejected without the
 *      header.
 *
 * The two checks together let a sibling control-plane container drive
 * tenant config without the operator having to construct a privileged
 * admin scope on the API key. Future hardening (real `admin` scope on the
 * key + RBAC) lives on the multi-tenancy off-ramp.
 *
 * TODO(Track 1): once `CANONRY_ENABLE_CLOUD_BOOTSTRAP` is consolidated into
 * a single config surface (probably a `cloudBootstrapEnabled` field on
 * `ApiRoutesOptions`), drop the direct env-var read and accept a boolean.
 */
export function requireCloudBootstrap(request: FastifyRequest): void {
  if (!cloudBootstrapEnabled()) {
    // Return 404 (not 403) so unauthenticated probes can't fingerprint
    // whether a deployment is hosted vs. OSS. `notFound('endpoint', ...)`
    // matches the global error handler's existing 404 envelope.
    throw notFound('endpoint', request.url.split('?')[0] ?? '/')
  }
  // Header values can be string | string[] under HTTP; only accept the
  // exact scalar '1' so cookies / accidental duplicates never satisfy.
  const adminScope = request.headers['x-admin-scope']
  if (adminScope !== '1') {
    throw forbidden('This endpoint requires the X-Admin-Scope header.')
  }
}

/**
 * Accept the same truthy set as `packages/config/src/index.ts`'s
 * `parseBooleanFlag` (`1`, `true`, `yes`, `on`, case-insensitive). Keeping
 * the two helpers in sync avoids a config drift where an operator sees
 * `readCloudModeFlags()` report cloud-enabled while the routes still 404
 * because they only honored the literal `'1'`.
 */
function cloudBootstrapEnabled(): boolean {
  const v = process.env.CANONRY_ENABLE_CLOUD_BOOTSTRAP?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * Minimal in-memory fixed-window rate limiter for the unauthenticated /
 * brute-force-exposed endpoints (password login, first-time setup, guest
 * report claim). Keyed per `(bucket, client-ip)`.
 *
 * In-memory matches the single-tenant deployment posture (one process per
 * trust boundary — see root AGENTS.md "Deployment Posture") and the
 * existing in-memory session store. Behind a reverse proxy without
 * `trustProxy`, all clients collapse to the proxy IP, so the limiter just
 * becomes stricter (a global cap) rather than failing open — acceptable for
 * brute-force defense.
 *
 * **Construct one per plugin registration** (closure-scoped state), NOT at
 * module load — that keeps each Fastify app instance (and each test) isolated
 * instead of sharing a process-global bucket map.
 */
export interface RateLimiter {
  /**
   * Throw `quotaExceeded` (429) when the caller's IP has exceeded `max`
   * requests in the trailing `windowMs` for this `bucket`. Otherwise record
   * the hit and return.
   */
  check(request: Pick<FastifyRequest, 'ip'>, opts: { bucket: string; max: number; windowMs: number }): void
}

export function createRateLimiter(): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  return {
    check(request, opts) {
      const now = Date.now()
      // Opportunistic prune so the map can't grow unbounded under churn.
      if (buckets.size > 2000) {
        for (const [k, v] of buckets) {
          if (v.resetAt <= now) buckets.delete(k)
        }
      }
      const ip = request.ip || 'unknown'
      const key = `${opts.bucket}:${ip}`
      const entry = buckets.get(key)
      if (!entry || entry.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + opts.windowMs })
        return
      }
      entry.count++
      if (entry.count > opts.max) {
        const seconds = Math.round(opts.windowMs / 1000)
        throw quotaExceeded(`${opts.bucket} (max ${opts.max} requests per ${seconds}s — slow down and retry shortly)`)
      }
    },
  }
}

export interface AuditEntry {
  projectId?: string | null
  actor: string
  action: string
  entityType: string
  entityId?: string | null
  diff?: unknown
  /**
   * User-Agent header from the originating HTTP request. Pass
   * `request.headers['user-agent']` from any route handler so
   * destructive events can be attributed to a specific client
   * (CLI version, browser, MCP adapter, external script) on
   * post-mortem. Optional — non-HTTP write paths (scheduler,
   * run-coordinator, direct CLI writes) leave it null.
   */
  userAgent?: string | null
  /**
   * Caller-supplied trace key for cross-request correlation. The
   * Aero agent populates this with its session id so a related
   * sequence of mutations can be grouped. Optional.
   */
  actorSession?: string | null
}

/** Accepts both the main DatabaseClient and a Drizzle transaction context */
export function writeAuditLog(db: Pick<DatabaseClient, 'insert'>, entry: AuditEntry) {
  const now = new Date().toISOString()
  db.insert(auditLog).values({
    id: crypto.randomUUID(),
    projectId: entry.projectId ?? null,
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    diff: entry.diff != null ? JSON.stringify(entry.diff) : null,
    userAgent: entry.userAgent ?? null,
    actorSession: entry.actorSession ?? null,
    createdAt: now,
  }).run()
}

/**
 * Helper that extracts attribution fields from a Fastify request and
 * folds them into an `AuditEntry`. Pass the request object plus the
 * domain-specific fields and skip the boilerplate of pulling headers
 * by hand at every call site.
 *
 *   writeAuditLog(tx, auditFromRequest(request, {
 *     projectId, actor: 'api', action: 'queries.replaced', entityType: 'query', diff: {...},
 *   }))
 */
export function auditFromRequest(
  request: Pick<import('fastify').FastifyRequest, 'headers'>,
  entry: AuditEntry,
): AuditEntry {
  const ua = request.headers['user-agent']
  // Header is `string | string[] | undefined` per Fastify types; collapse
  // arrays (rare but possible for duplicated headers) to a comma-joined
  // string so the DB column stays a single value.
  const userAgent = Array.isArray(ua) ? ua.join(', ') : ua ?? null
  // Honor an optional `X-Canonry-Actor-Session` header for callers that
  // want to thread their own correlation key (Aero agent sessions, agent
  // runtimes, batch scripts). Stays null when absent.
  const sess = request.headers['x-canonry-actor-session']
  const actorSession = Array.isArray(sess) ? sess.join(', ') : sess ?? null
  return {
    ...entry,
    userAgent: entry.userAgent ?? userAgent,
    actorSession: entry.actorSession ?? actorSession,
  }
}

export function incrementUsage(db: DatabaseClient, scope: string, metric: string) {
  const now = new Date()
  const period = now.toISOString().slice(0, 10)

  db.insert(usageCounters).values({
    id: crypto.randomUUID(),
    scope,
    period,
    metric,
    count: 1,
    updatedAt: now.toISOString(),
  }).onConflictDoUpdate({
    target: [usageCounters.scope, usageCounters.period, usageCounters.metric],
    set: {
      count: sql`${usageCounters.count} + 1`,
      updatedAt: now.toISOString(),
    },
  }).run()
}

export interface SnapshotVisibilityProject {
  displayName: string
  canonicalDomain: string
  ownedDomains?: string | string[] | null
  aliases?: string | string[] | null
}

function resolveSnapshotMentionResult(
  snapshot: { answerMentioned?: boolean | null; answerText?: string | null },
  project: SnapshotVisibilityProject,
): { mentioned: boolean; matchedTerms: string[] } {
  // Prefer recomputing from answerText so mentioned and matchedTerms always
  // derive from the same source of truth (no contradiction possible).
  if (snapshot.answerText) {
    const domains = effectiveDomains({
      canonicalDomain: project.canonicalDomain,
      ownedDomains: normalizeOwnedDomains(project.ownedDomains),
    })
    const brandNames = effectiveBrandNames({
      displayName: project.displayName,
      aliases: normalizeOwnedDomains(project.aliases),
    })
    return extractAnswerMentions(snapshot.answerText, brandNames, domains)
  }
  // Legacy fallback: answerText was not stored; use the persisted boolean if available.
  // matchedTerms cannot be derived without text, so return [] — no contradiction.
  if (typeof snapshot.answerMentioned === 'boolean') {
    return { mentioned: snapshot.answerMentioned, matchedTerms: [] }
  }
  return { mentioned: false, matchedTerms: [] }
}

export function resolveSnapshotAnswerMentioned(
  snapshot: { answerMentioned?: boolean | null; answerText?: string | null },
  project: SnapshotVisibilityProject,
): boolean {
  return resolveSnapshotMentionResult(snapshot, project).mentioned
}

export function resolveSnapshotVisibilityState(
  snapshot: { answerMentioned?: boolean | null; answerText?: string | null },
  project: SnapshotVisibilityProject,
): VisibilityState {
  return visibilityStateFromAnswerMentioned(resolveSnapshotMentionResult(snapshot, project).mentioned)
}

/**
 * Canonical-vocabulary equivalent of `resolveSnapshotVisibilityState`.
 * Returns `'mentioned'` / `'not-mentioned'` for the same underlying signal.
 * New callers should prefer this; legacy callers continue to work via the
 * `Visibility` variant.
 */
export function resolveSnapshotMentionState(
  snapshot: { answerMentioned?: boolean | null; answerText?: string | null },
  project: SnapshotVisibilityProject,
): MentionState {
  return mentionStateFromAnswerMentioned(resolveSnapshotMentionResult(snapshot, project).mentioned)
}

export function resolveSnapshotMatchedTerms(
  snapshot: { answerMentioned?: boolean | null; answerText?: string | null },
  project: SnapshotVisibilityProject,
): string[] {
  return resolveSnapshotMentionResult(snapshot, project).matchedTerms
}

function normalizeOwnedDomains(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  const parsed = parseJsonColumn<unknown[]>(typeof value === 'string' ? value : null, [])
  return parsed.filter((item): item is string => typeof item === 'string')
}
