import crypto from 'node:crypto'
import { and, eq, or } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs } from '@ainyc/canonry-db'

export interface QueueRunParams {
  projectId: string
  kind?: string
  trigger?: string
  createdAt?: string
}

export type QueueRunResult =
  | { conflict: true; activeRunId: string }
  | { conflict: false; runId: string }

export function queueRunIfProjectIdle(db: DatabaseClient, params: QueueRunParams): QueueRunResult {
  const createdAt = params.createdAt ?? new Date().toISOString()
  const kind = params.kind ?? 'answer-visibility'
  const trigger = params.trigger ?? 'manual'
  const runId = crypto.randomUUID()

  return db.transaction((tx) => {
    const activeRun = tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, params.projectId),
          or(eq(runs.status, 'queued'), eq(runs.status, 'running')),
        ),
      )
      .get()

    if (activeRun) {
      return { conflict: true, activeRunId: activeRun.id } as const
    }

    tx.insert(runs).values({
      id: runId,
      projectId: params.projectId,
      kind,
      status: 'queued',
      trigger,
      createdAt,
    }).run()

    return { conflict: false, runId } as const
  })
}
