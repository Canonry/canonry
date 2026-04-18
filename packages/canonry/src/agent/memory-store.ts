import crypto from 'node:crypto'
import { and, desc, eq, like, sql } from 'drizzle-orm'
import { agentMemory, type DatabaseClient } from '@ainyc/canonry-db'
import {
  AGENT_MEMORY_VALUE_MAX_BYTES,
  MemorySources,
  type AgentMemoryEntryDto,
  type MemorySource,
} from '@ainyc/canonry-contracts'

/**
 * Key prefix reserved for LLM-authored transcript compaction summaries.
 * Users and the remember/forget tools may not write keys in this namespace
 * so compaction notes can be cleaned up independently.
 */
export const COMPACTION_KEY_PREFIX = 'compaction:'

/**
 * Per-session cap on retained compaction notes. Older rows for the same
 * session are deleted when a new compaction note is written.
 */
export const COMPACTION_NOTES_PER_SESSION = 3

function rowToDto(row: {
  id: string
  key: string
  value: string
  source: string
  createdAt: string
  updatedAt: string
}): AgentMemoryEntryDto {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    source: row.source as MemorySource,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export interface ListMemoryOptions {
  limit?: number
}

export function listMemoryEntries(
  db: DatabaseClient,
  projectId: string,
  opts: ListMemoryOptions = {},
): AgentMemoryEntryDto[] {
  const query = db
    .select()
    .from(agentMemory)
    .where(eq(agentMemory.projectId, projectId))
    .orderBy(desc(agentMemory.updatedAt))

  const rows = opts.limit === undefined ? query.all() : query.limit(opts.limit).all()
  return rows.map(rowToDto)
}

export interface UpsertMemoryEntryArgs {
  projectId: string
  key: string
  value: string
  source: MemorySource
}

export function upsertMemoryEntry(
  db: DatabaseClient,
  args: UpsertMemoryEntryArgs,
): AgentMemoryEntryDto {
  if (Buffer.byteLength(args.value, 'utf8') > AGENT_MEMORY_VALUE_MAX_BYTES) {
    throw new Error(
      `memory value exceeds ${AGENT_MEMORY_VALUE_MAX_BYTES} bytes (got ${Buffer.byteLength(args.value, 'utf8')})`,
    )
  }
  if (args.source !== MemorySources.compaction && args.key.startsWith(COMPACTION_KEY_PREFIX)) {
    throw new Error(`memory key prefix "${COMPACTION_KEY_PREFIX}" is reserved for compaction notes`)
  }

  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  db.insert(agentMemory)
    .values({
      id,
      projectId: args.projectId,
      key: args.key,
      value: args.value,
      source: args.source,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [agentMemory.projectId, agentMemory.key],
      set: {
        value: args.value,
        source: args.source,
        updatedAt: now,
      },
    })
    .run()

  const row = db
    .select()
    .from(agentMemory)
    .where(and(eq(agentMemory.projectId, args.projectId), eq(agentMemory.key, args.key)))
    .get()
  if (!row) throw new Error('memory upsert produced no row')
  return rowToDto(row)
}

/**
 * Delete a note. Returns true if a row was removed, false if the key did
 * not exist (non-error). Callers surface 'missing' to Aero rather than
 * treating this as a failure.
 */
export function deleteMemoryEntry(
  db: DatabaseClient,
  projectId: string,
  key: string,
): boolean {
  const result = db
    .delete(agentMemory)
    .where(and(eq(agentMemory.projectId, projectId), eq(agentMemory.key, key)))
    .run()
  // better-sqlite3 returns `{ changes: number }`; drizzle surfaces it as `changes`.
  const changes = (result as { changes?: number }).changes ?? 0
  return changes > 0
}

/**
 * Load the N most-recently-updated memory entries for hydrating the system
 * prompt `<memory>` block. Thin wrapper around `listMemoryEntries` so the
 * intent shows up at the call site.
 */
export function loadRecentForHydrate(
  db: DatabaseClient,
  projectId: string,
  limit: number,
): AgentMemoryEntryDto[] {
  return listMemoryEntries(db, projectId, { limit })
}

export interface WriteCompactionNoteArgs {
  projectId: string
  sessionId: string
  summary: string
  removedCount: number
}

/**
 * Record a compaction summary as a memory row with
 * `source='compaction'` and key `compaction:<sessionId>:<iso-ts>`. Keeps
 * only the most recent `COMPACTION_NOTES_PER_SESSION` rows for the given
 * session — older rows are pruned in the same transaction so the hydrate
 * `<memory>` block doesn't fill with stale summaries.
 */
export function writeCompactionNote(
  db: DatabaseClient,
  args: WriteCompactionNoteArgs,
): AgentMemoryEntryDto {
  if (Buffer.byteLength(args.summary, 'utf8') > AGENT_MEMORY_VALUE_MAX_BYTES) {
    throw new Error(
      `compaction summary exceeds ${AGENT_MEMORY_VALUE_MAX_BYTES} bytes; summarizer produced too much text`,
    )
  }
  const now = new Date().toISOString()
  const key = `${COMPACTION_KEY_PREFIX}${args.sessionId}:${now}`
  const id = crypto.randomUUID()

  let inserted: AgentMemoryEntryDto | undefined
  db.transaction((tx) => {
    tx.insert(agentMemory)
      .values({
        id,
        projectId: args.projectId,
        key,
        value: args.summary,
        source: MemorySources.compaction,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    // Retain only the newest N rows per session; drop the rest.
    const sessionPrefix = `${COMPACTION_KEY_PREFIX}${args.sessionId}:`
    const existing = tx
      .select({ id: agentMemory.id, updatedAt: agentMemory.updatedAt })
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.projectId, args.projectId),
          like(agentMemory.key, `${sessionPrefix}%`),
        ),
      )
      .orderBy(desc(agentMemory.updatedAt))
      .all()

    const stale = existing.slice(COMPACTION_NOTES_PER_SESSION).map((r) => r.id)
    if (stale.length > 0) {
      tx.delete(agentMemory)
        .where(sql`${agentMemory.id} IN (${sql.join(stale.map((s) => sql`${s}`), sql`, `)})`)
        .run()
    }

    const row = tx
      .select()
      .from(agentMemory)
      .where(and(eq(agentMemory.projectId, args.projectId), eq(agentMemory.key, key)))
      .get()
    if (row) inserted = rowToDto(row)
  })

  if (!inserted) throw new Error('compaction note write produced no row')
  return inserted
}
