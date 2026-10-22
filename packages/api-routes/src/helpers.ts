import crypto from 'node:crypto'
import { eq, ne, sql, type SQL } from 'drizzle-orm'
import type { DatabaseClient } from '@canonry/canonry-db'
import { projects, runs, auditLog, usageCounters, parseJsonColumn } from '@canonry/canonry-db'
import {
  countsAsMention,
  extractAnswerMentions,
  effectiveBrandNames,
  effectiveDomains,
  mentionStateFromAnswerMentioned,
  notFound,
  RunTriggers,
  type MentionIdentity,
  type RunKind,
  type RunTrigger,
  visibilityStateFromAnswerMentioned,
  type MentionState,
  type VisibilityState,
} from '@canonry/canonry-contracts'
import { getRequestContext, requestAuditIdentity, sanitizeRequestContext } from './request-context.js'

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

/** The host-only claim consumed when its scheduler calls a sync endpoint. */
export type ScheduledSyncClaim = (projectName: string, kind: RunKind, sourceId?: string) => boolean

/** Stable in-process key for one scheduled sync request. */
export function syncRunClaimKey(projectName: string, kind: RunKind, sourceId?: string): string {
  return [projectName, kind, sourceId].filter((part): part is string => part !== undefined).join('\u0000')
}

/** A scheduled trigger is server-owned; every unclaimed request stays manual. */
export function syncRunTrigger(
  claim: ScheduledSyncClaim | undefined,
  projectName: string,
  kind: RunKind,
  sourceId?: string,
): RunTrigger {
  return claim?.(projectName, kind, sourceId) ? RunTriggers.scheduled : RunTriggers.manual
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
  /** Server-issued request correlation id for an HTTP mutation. */
  requestId?: string | null
  /** ID of the API credential that authenticated an HTTP mutation. */
  credentialId?: string | null
}

/** Accepts both the main DatabaseClient and a Drizzle transaction context */
export function writeAuditLog(db: Pick<DatabaseClient, 'insert'>, entry: AuditEntry) {
  const context = getRequestContext()
  // `api` has always meant an ordinary HTTP caller. Keep explicit business
  // actors (scheduler, system, paid-workflow actors, etc.) exactly as named.
  const actor = entry.actor === 'api' ? context?.actor ?? entry.actor : entry.actor
  const now = new Date().toISOString()
  db.insert(auditLog).values({
    id: crypto.randomUUID(),
    projectId: entry.projectId ?? null,
    actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    diff: entry.diff != null ? JSON.stringify(entry.diff) : null,
    userAgent: sanitizeRequestContext(entry.userAgent ?? context?.userAgent),
    actorSession: sanitizeRequestContext(entry.actorSession ?? context?.actorSession),
    requestId: entry.requestId ?? context?.requestId ?? null,
    credentialId: entry.credentialId ?? context?.credentialId ?? null,
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
  request: Pick<import('fastify').FastifyRequest, 'headers' | 'principal' | 'apiKey'>,
  entry: AuditEntry,
): AuditEntry {
  const userAgent = sanitizeRequestContext(request.headers['user-agent'])
  // This is untrusted caller context only: it is useful for correlation but
  // must never determine identity or authorization.
  const actorSession = sanitizeRequestContext(request.headers['x-canonry-actor-session'])
  const identity = requestAuditIdentity(request)
  const context = getRequestContext()
  const actor = entry.actor === 'api' ? identity.actor ?? entry.actor : entry.actor
  return {
    ...entry,
    actor,
    credentialId: entry.credentialId ?? identity.credentialId ?? context?.credentialId ?? null,
    userAgent: sanitizeRequestContext(entry.userAgent ?? userAgent),
    actorSession: sanitizeRequestContext(entry.actorSession ?? actorSession),
    requestId: entry.requestId ?? context?.requestId ?? null,
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

/** A stored answer as the read-time mention helpers read it. */
export interface SnapshotMentionInput {
  answerMentioned?: boolean | null
  answerText?: string | null
  /**
   * Sentiment's stored identity verdict; `wrong-subject` keeps a name match
   * from counting. Required so a reader cannot silently skip it.
   */
  mentionIdentity: MentionIdentity | null
}

function resolveSnapshotMentionResult(
  snapshot: SnapshotMentionInput,
  project: SnapshotVisibilityProject,
): { mentioned: boolean; matchedTerms: string[] } {
  // Prefer recomputing from answerText so mentioned and matchedTerms always
  // derive from the same source of truth. The one exception is sentiment's
  // `wrong-subject` verdict: the terms the answer wrote stay listed, and
  // `mentionIdentity` on the DTO says why they do not count.
  if (snapshot.answerText) {
    const domains = effectiveDomains({
      canonicalDomain: project.canonicalDomain,
      ownedDomains: normalizeOwnedDomains(project.ownedDomains),
    })
    const brandNames = effectiveBrandNames({
      displayName: project.displayName,
      aliases: normalizeOwnedDomains(project.aliases),
    })
    const matched = extractAnswerMentions(snapshot.answerText, brandNames, domains)
    return { mentioned: countsAsMention(matched.mentioned, snapshot.mentionIdentity), matchedTerms: matched.matchedTerms }
  }
  // Legacy fallback: answerText was not stored; use the persisted boolean if available.
  // matchedTerms cannot be derived without text, so return [] — no contradiction.
  if (typeof snapshot.answerMentioned === 'boolean') {
    return { mentioned: snapshot.answerMentioned, matchedTerms: [] }
  }
  return { mentioned: false, matchedTerms: [] }
}

export function resolveSnapshotAnswerMentioned(
  snapshot: SnapshotMentionInput,
  project: SnapshotVisibilityProject,
): boolean {
  return resolveSnapshotMentionResult(snapshot, project).mentioned
}

export function resolveSnapshotVisibilityState(
  snapshot: SnapshotMentionInput,
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
  snapshot: SnapshotMentionInput,
  project: SnapshotVisibilityProject,
): MentionState {
  return mentionStateFromAnswerMentioned(resolveSnapshotMentionResult(snapshot, project).mentioned)
}

export function resolveSnapshotMatchedTerms(
  snapshot: SnapshotMentionInput,
  project: SnapshotVisibilityProject,
): string[] {
  return resolveSnapshotMentionResult(snapshot, project).matchedTerms
}

function normalizeOwnedDomains(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  const parsed = parseJsonColumn<unknown[]>(typeof value === 'string' ? value : null, [])
  return parsed.filter((item): item is string => typeof item === 'string')
}
