import crypto from 'node:crypto'
import { eq, ne, sql, type SQL } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { projects, runs, auditLog, usageCounters, parseJsonColumn } from '@ainyc/canonry-db'
import {
  extractAnswerMentions,
  effectiveBrandNames,
  effectiveDomains,
  mentionStateFromAnswerMentioned,
  notFound,
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
