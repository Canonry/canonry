import crypto from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { projects, auditLog, usageCounters, parseJsonColumn } from '@ainyc/canonry-db'
import {
  extractAnswerMentions,
  effectiveDomains,
  notFound,
  visibilityStateFromAnswerMentioned,
  type VisibilityState,
} from '@ainyc/canonry-contracts'

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
    createdAt: now,
  }).run()
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
    return extractAnswerMentions(snapshot.answerText, project.displayName, domains)
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
