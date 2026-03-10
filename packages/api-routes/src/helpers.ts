import crypto from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { projects, auditLog, usageCounters } from '@ainyc/canonry-db'
import { notFound } from '@ainyc/canonry-contracts'

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
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const existing = db
    .select()
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.scope, scope),
        eq(usageCounters.period, period),
        eq(usageCounters.metric, metric),
      ),
    )
    .get()

  if (existing) {
    db.update(usageCounters)
      .set({ count: existing.count + 1, updatedAt: now.toISOString() })
      .where(eq(usageCounters.id, existing.id))
      .run()
  } else {
    db.insert(usageCounters).values({
      id: crypto.randomUUID(),
      scope,
      period,
      metric,
      count: 1,
      updatedAt: now.toISOString(),
    }).run()
  }
}
